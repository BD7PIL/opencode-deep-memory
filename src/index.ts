/**
 * opencode-deep-memory — Plugin Entry
 *
 * Wires together all hooks and tools:
 *   - chat.params: record sessionID → agent map
 *   - chat.message: capture keyword-matching user messages to notes.md
 *   - experimental.chat.system.transform: adaptive memory injection
 *   - event: session.created → resume detection + auto-dream scheduling
 *   - tool: memory_search / memory_store / memory_forget
 *
 * Storage: <data>/local-memory/{global,projects/<hash>}/...
 * See DESIGN.md for full architecture.
 */

import type { Plugin, PluginInput, PluginModule, Hooks } from "@opencode-ai/plugin";

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { createLogger, resolveDataRoot, acquireLock } from "./shared/index.js";
import { projectMemoryDir } from "./shared/paths.js";
import { createPluginState } from "./hooks/shared-state.js";
import { createChatParamsHandler } from "./hooks/chat-params.js";
import { createChatMessageHandler } from "./hooks/chat-message.js";
import { createSystemTransformHandler } from "./hooks/system-transform.js";
import { handleSessionCreated as handleResume } from "./schedule/resume.js";
import { handleSessionCreatedForDream } from "./schedule/auto-dream.js";
import { handleSessionCreatedForDistill } from "./schedule/auto-distill.js";
import { SearchService } from "./search/service.js";
import { createMemoryTools, createDeepExpandTool } from "./tools/index.js";
import { createCompactingHandler } from "./hooks/compacting.js";
import { createMessagesTransformHandler } from "./hooks/messages-transform.js";
import { createNotifyHandler } from "./hooks/notify.js";
import { runEnrichment } from "./extract/enrich.js";
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
        logger.debug("resolved fallback model from config", { defaultModel });
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

  const memoryTools = createMemoryTools(searchService, { projectPath });
  const notify = createNotifyHandler(input.client, logger.for("notify"));

  const hooks: Hooks = {
    "chat.params": createChatParamsHandler(
      state,
      logger.for("chat-params"),
    ),

    "chat.message": createChatMessageHandler({
      projectPath,
      state,
      logger: logger.for("chat-message"),
    }),

    "experimental.chat.system.transform": createSystemTransformHandler(
      state,
      projectPath,
      searchService,
      logger.for("system-transform"),
      tracker,
    ),

    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          // Both consumers handle their own parentID / title-prefix guards.
          // Run them in parallel; failures in one must not affect the other.

          // Narrow the event shape for our handlers (they only read .properties.info.{id,parentID,title,directory}).
          // The SDK's full Session type has more fields; we defensively pick what we need.
          const info = (event.properties as { info?: unknown }).info;
          if (!info || typeof info !== "object") {
            logger.debug("event session.created: missing info, skipping");
            return;
          }
          const i = info as {
            id?: unknown;
            parentID?: unknown;
            title?: unknown;
            directory?: unknown;
          };
          if (typeof i.id !== "string") {
            logger.debug("event session.created: info.id not string, skipping");
            return;
          }

          const narrowed = {
            type: "session.created" as const,
            properties: {
              info: {
                id: i.id,
                parentID: typeof i.parentID === "string" ? i.parentID : undefined,
                title: typeof i.title === "string" ? i.title : "",
                directory:
                  typeof i.directory === "string" ? i.directory : projectPath,
              },
            },
          };

          await Promise.allSettled([
            handleResume({ state, event: narrowed, projectPath, logger: logger.for("resume") }),
            handleSessionCreatedForDream({
              event: narrowed,
              config: { client: input.client, projectPath, model: state.bestModel(), logger: logger.for("auto-dream") },
            }),
            handleSessionCreatedForDistill({
              event: narrowed,
              config: { client: input.client, projectPath, model: state.bestModel(), logger: logger.for("auto-distill") },
            }),
          ]);
          return;
        }

        if (event.type === "session.idle") {
          const idleSessionID = (event.properties as { sessionID?: string }).sessionID;
          if (idleSessionID && state.hasPendingEnrichment(idleSessionID)) {
            state.consumePendingEnrichment(idleSessionID);
            try {
              const result = await runEnrichment({
                client: input.client,
                projectPath,
                sessionID: idleSessionID,
                logger: logger.for("enrichment"),
              });
              logger.info("idle enrichment result", { ...result });
            } catch (err) {
              logger.warn("idle enrichment failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            logger.debug("event session.idle (no pending enrichment)");
          }

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
      if (input.tool !== "read") return;
      const filePath = (input.args as { path?: string; filePath?: string })?.path
        ?? (input.args as { filePath?: string })?.filePath;
      if (!filePath) return;
      const lang = getLanguage(filePath);
      if (!lang) return;
      tracker.recordRead(filePath, output.output || "");
    },

    "experimental.session.compacting": createCompactingHandler({
      client: input.client,
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
