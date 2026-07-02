/**
 * opencode-deep-memory — Plugin Entry
 *
 * Wires together all hooks and tools:
 *   - chat.params: record sessionID → agent map
 *   - experimental.chat.system.transform: V4 frozen TOOL_HINT + mtime-cached MEMORY.md
 *   - event: session.compacted → pressure calibration + audit log
 *   - tool: memory_search / memory_store / memory_forget / memory_expand / context_compress
 *
 * Storage: <data>/local-memory/{global,projects/<hash>}/...
 * See DESIGN.md for full architecture.
 */

import type { Plugin, PluginInput, PluginModule, Hooks } from "@opencode-ai/plugin";

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { createLogger, resolveDataRoot, acquireLock } from "./shared/index.js";
import { migrateV3toV4 } from "./shared/migrate.js";
import { projectMemoryDir } from "./shared/paths.js";
import { createPluginState } from "./hooks/shared-state.js";
import { createChatParamsHandler } from "./hooks/chat-params.js";
import { createSystemTransformHandler } from "./hooks/system-transform.js";
import { SearchService } from "./search/service.js";
import { createMemoryTools, createDeepExpandTool } from "./tools/index.js";
import { createCompactingHandler } from "./hooks/compacting.js";
import { createMessagesTransformHandler } from "./hooks/messages-transform.js";
import { createNotifyHandler } from "./hooks/notify.js";
import { calibrateFromCompaction, getCalibratedMaxContext } from "./compress/pressure.js";
import { RepoMapTracker } from "./repomap/tracker.js";
import { getLanguage } from "./repomap/extractor.js";

export const deepMemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const cached = (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"] as Hooks | undefined;
  if (cached) return cached;

  const logger = createLogger();
  const state = createPluginState();

  const projectPath = input.directory;
  const dataRoot = resolveDataRoot();

  logger.info("opencode-deep-memory starting", {
    projectPath,
    dataRoot,
    serverUrl: input.serverUrl.toString(),
  });

  try {
    await migrateV3toV4(projectPath, logger.for("migrate"));
  } catch (err) {
    logger.warn("V3→V4 migration failed (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const restored = state.restorePendingConsolidation(projectPath);
  if (restored) {
    logger.info("opencode-deep-memory: restored pending consolidation");
  }

  const searchService = new SearchService({
    dataRoot,
    projectPath,
    logger: logger.for("search"),
  });

  const tracker = new RepoMapTracker();

  try {
    input.client.config.get().then((configResult) => {
      const defaultModel = configResult.data?.model;
      if (typeof defaultModel === "string" && defaultModel.includes("/")) {
        const slashIdx = defaultModel.indexOf("/");
        state.recordFallbackModel({
          providerID: defaultModel.slice(0, slashIdx),
          modelID: defaultModel.slice(slashIdx + 1),
        });
      }
    }).catch((err) => {
      logger.debug("config.get failed, dream/distill will omit model", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.debug("config.get sync error (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Eagerly warm the index on plugin load (best-effort, non-blocking)
  searchService.ensureIndex().catch((err) => {
    logger.warn("Index warm-up failed (will retry on first search)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const memoryTools = createMemoryTools(searchService, state, { projectPath });
  const notify = createNotifyHandler(input.client, logger.for("notify"));

  const hooks: Hooks = {
    "chat.params": createChatParamsHandler(
      state,
      logger.for("chat-params"),
    ),

    "experimental.chat.system.transform": createSystemTransformHandler(
      state,
      projectPath,
      searchService,
      logger.for("system-transform"),
    ),

    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          return;
        }

        if (event.type === "session.idle") {
          const idleSessionID = (event.properties as { sessionID?: string }).sessionID;

          if (idleSessionID) {
            const pending = state.consumePendingNotify();
            if (pending) {
              try {
                await notify(idleSessionID, pending);
              } catch (err) {
                logger.debug("idle notify failed (non-fatal)", {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }

          return;
        }

        if (event.type === "session.compacted") {
          const compactedSessionID = (event.properties as { sessionID?: string }).sessionID;
          logger.info("event session.compacted", { sessionID: compactedSessionID });

          const lastTokens = state.lastInputTokens();
          if (lastTokens > 0) {
            calibrateFromCompaction(lastTokens);
            logger.info("pressure calibrated", {
              trigger: "compaction",
              lastInputTokens: lastTokens,
              derivedMaxContext: getCalibratedMaxContext(),
            });
          }

          try {
            const auditLogDir = projectMemoryDir(projectPath);
            await mkdir(auditLogDir, { recursive: true });
            const auditLogPath = path.join(auditLogDir, ".compaction-log.jsonl");
            const line = JSON.stringify({ timestamp: new Date().toISOString(), sessionID: compactedSessionID }) + "\n";

            const releaseLock = await acquireLock(auditLogPath);
            try {
              await appendFile(auditLogPath, line, "utf-8");
            } finally {
              releaseLock();
            }
          } catch (auditErr) {
            // Must not throw from event handler — swallow and log.
            logger.warn("Failed to write compaction audit log", {
              error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            });
          }

          return;
        }

        if (event.type === "session.error") {
          const props = event.properties as { sessionID?: string; error?: unknown };
          logger.warn("event session.error", {
            sessionID: props.sessionID,
            error: props.error,
          });
          return;
        }

        if (event.type === "session.deleted") {
          const info = (event.properties as { info?: { id?: string } }).info;
          if (info?.id) {
            state.forgetAgent(info.id);
          }
          return;
        }
      } catch (err) {
        // Event handler must NEVER throw — would break OpenCode event loop.
        logger.error("event handler threw (swallowed)", {
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    tool: { ...memoryTools, deep_expand: createDeepExpandTool(state) },

    "tool.execute.after": async (input, output) => {
      const filePath = (input.args as { path?: string; filePath?: string })?.path
        ?? (input.args as { filePath?: string })?.filePath;
      if (!filePath) return;

      if (input.tool === "read") {
        const lang = getLanguage(filePath);
        if (!lang) return;
        tracker.recordRead(filePath, output.output || "");
      }

      if (input.tool === "edit" || input.tool === "write") {
        state.trackEdit(filePath);
      }
    },

    "experimental.session.compacting": createCompactingHandler({
      client: input.client as never,
      state,
      projectPath,
      logger: logger.for("compacting"),
      tracker,
    }),

    "experimental.chat.messages.transform": createMessagesTransformHandler(
      state,
      logger.for("messages-transform"),
    ),
  };

  (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"] = hooks;
  return hooks;
};

const pluginModule: PluginModule = {
  id: "opencode-deep-memory",
  server: deepMemoryPlugin,
};

export default pluginModule;
