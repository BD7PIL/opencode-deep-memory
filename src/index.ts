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
import { installPluginCommands } from "./shared/install-commands.js";
import { projectMemoryDir, memoryFilePath } from "./shared/paths.js";
import { createPluginState } from "./hooks/shared-state.js";
import { createChatParamsHandler } from "./hooks/chat-params.js";
import { createSystemTransformHandler } from "./hooks/system-transform.js";
import { SearchService } from "./search/service.js";
import { createMemoryTools, createDeepExpandTool } from "./tools/index.js";
import { createCompactingHandler } from "./hooks/compacting.js";
import { createMessagesTransformHandler } from "./hooks/messages-transform.js";
import { calibrateFromCompaction, getCalibratedMaxContext } from "./compress/pressure.js";
import { RepoMapTracker } from "./repomap/tracker.js";
import { getLanguage } from "./repomap/extractor.js";
import { existsSync as existsSyncSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { buildConsolidationPrompt } from "./extract/consolidate.js";

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

  installPluginCommands(projectPath, logger.for("installCommands"));

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

  const memoryTools = createMemoryTools(searchService, state, { projectPath, client: input.client });

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
            try {
              await handleIdleConsolidation(input.client, state, projectPath, idleSessionID, logger.for("idle-consolidation"));
            } catch (err) {
              logger.debug("idle consolidation failed (non-fatal)", {
                error: err instanceof Error ? err.message : String(err),
              });
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
      input.client,
      logger.for("messages-transform"),
    ),
  };

  (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"] = hooks;
  return hooks;
};

type IdleClient = {
  session: {
    messages: (args: { path: { id: string }; query?: { limit?: number } }) => Promise<{ data?: unknown[] }>;
    create: (args: { body: { parentID: string; title: string }; query: { directory: string } }) => Promise<{ data?: { id?: string } }>;
    promptAsync: (args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }>; agent: string } }) => Promise<unknown>;
  };
  tui?: {
    showToast?: (args: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown>;
  };
};

async function showToast(client: IdleClient, message: string, variant: "info" | "warning" = "info", duration = 5000): Promise<void> {
  try {
    await client.tui?.showToast?.({
      body: { title: "deep-memory", message, variant, duration },
    });
  } catch {}
}

async function handleIdleConsolidation(
  client: unknown,
  state: ReturnType<typeof createPluginState>,
  projectPath: string,
  sessionID: string,
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  },
): Promise<void> {
  const typedClient = client as IdleClient;
  if (!typedClient?.session) return;

  const memPath = memoryFilePath("project", "memory", projectPath);
  if (!existsSyncSync(memPath)) return;

  const content = await readFile(memPath, "utf8");
  const memLines = content.split("\n").length;
  const memStat = await import("node:fs").then(m => m.statSync(memPath));

  const pending = state.consumePendingConsolidation(sessionID);
  if (pending) {
    const currentMtime = memStat.mtimeMs;
    if (currentMtime > pending.memMtime) {
      await showToast(typedClient, "▣ deep-memory | consolidation discarded (mtime race)", "warning");
      logger.info("idle consolidation: discarded (mtime race)");
    } else {
      try {
        const resp = await typedClient.session.messages({ path: { id: pending.subSessionID }, query: { limit: 1 } });
        const msgs = resp.data ?? [];
        const lastAssistant = msgs[msgs.length - 1] as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> } | undefined;
        if (lastAssistant?.info?.role === "assistant") {
          for (const part of lastAssistant.parts ?? []) {
            if (part.type === "text" && part.text) {
              const release = await acquireLock(memPath);
              try {
                const current = await readFile(memPath, "utf8");
                const backupPath = memPath.replace("MEMORY.md", "MEMORY.bak.md");
                await writeFile(backupPath, current, "utf8");
                await writeFile(memPath, part.text, "utf8");
                const newLines = part.text.split("\n").length;
                state.recordConsolidationDone(newLines);
                await showToast(typedClient, `▣ deep-memory | memory consolidated: MEMORY.md (${newLines} lines / ${Math.round(part.text.length / 1024 * 10) / 10} KB)`);
                logger.info("idle consolidation: applied", { lines: newLines });
              } finally {
                release();
              }
              break;
            }
          }
        }
      } catch (err) {
        logger.warn("idle consolidation: failed to apply result", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return;
  }

  if (!state.shouldConsolidate(memLines)) return;

  try {
    const resp = await typedClient.session.create({
      body: {
        parentID: sessionID,
        title: `Memory Consolidation ${new Date().toISOString().slice(0, 10)}`,
      },
      query: { directory: projectPath },
    });
    const subID = resp?.data?.id;
    if (!subID) return;

    const prompt = buildConsolidationPrompt(content);
    await typedClient.session.promptAsync({
      path: { id: subID },
      body: { parts: [{ type: "text", text: prompt }], agent: "general" },
    });

    state.setPendingConsolidation(sessionID, { subSessionID: subID, memMtime: memStat.mtimeMs });
    state.persistPendingConsolidation(projectPath);
    await showToast(typedClient, "▣ deep-memory | memory consolidation spawned (general)", "info", 3000);
    logger.info("idle consolidation: spawned", { subSessionID: subID, lines: memLines });
  } catch (err) {
    logger.warn("idle consolidation: failed to spawn", { error: err instanceof Error ? err.message : String(err) });
  }
}

const pluginModule: PluginModule = {
  id: "opencode-deep-memory",
  server: deepMemoryPlugin,
};

export default pluginModule;
