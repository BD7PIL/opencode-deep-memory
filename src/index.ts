/**
 * opencode-deep-memory — Plugin Entry
 *
 * Wires together all hooks and tools:
 *   - chat.params: record sessionID → agent map
 *   - experimental.chat.system.transform: V4 frozen TOOL_HINT + mtime-cached MEMORY.md
 *   - event: session.compacted → pressure calibration + audit log
 *   - tool: memory_search / memory_store / memory_forget / memory_expand / context_compress
 *
 * Storage: <projectPath>/.deep-memory/ (project) + global root (cross-project);
 * layout documented in src/shared/paths.ts.
 */

import type { Plugin, PluginInput, PluginModule, Hooks } from "@opencode-ai/plugin";

import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { createLogger, resolveDataRoot, acquireLock } from "./shared/index.js";
import { migrateV3toV4 } from "./shared/migrate.js";
import { installPluginCommands } from "./shared/install-commands.js";
import { projectMemoryDir, memoryFilePath } from "./shared/paths.js";
import { createPluginState } from "./hooks/shared-state.js";
import { createChatParamsHandler } from "./hooks/chat-params.js";
import { createChatMessageHandler } from "./hooks/chat-message.js";
import { createSystemTransformHandler } from "./hooks/system-transform.js";
import { SearchService } from "./search/service.js";
import { createMemoryTools, createDeepExpandTool } from "./tools/index.js";
import { createCompactingHandler } from "./hooks/compacting.js";
import { createMessagesTransformHandler } from "./hooks/messages-transform.js";
import { calibrateFromCompaction, getCalibratedMaxContext } from "./compress/pressure.js";
import { RepoMapTracker } from "./repomap/tracker.js";
import { getLanguage } from "./repomap/extractor.js";
import { existsSync as existsSyncSync, statSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { buildConsolidationPrompt, validateConsolidation } from "./extract/consolidate.js";
import {
  resolveConsolidationConfig,
  type ConsolidationConfig,
  type ConsolidationOptions,
} from "./shared/consolidation-config.js";
import { probeAgent } from "./shared/agent-probe.js";

/**
 * Hooks memo, keyed by project directory.
 *
 * v2 hosts instantiate plugins PER LOCATION. A single shared hooks object meant
 * only the first location's projectPath/state/client were ever used: every
 * other project consolidated the WRONG project's MEMORY.md, and an idle in any
 * project could trigger it.
 *
 * Entries hold the in-flight PROMISE, not just the finished hooks: building is
 * async, so two concurrent setups for one directory would both miss a
 * finished-only memo and produce TWO live instances — each with its own event
 * subscription, i.e. two consolidation spawns per idle (observed: two
 * sub-sessions in the same second). The promise placeholder closes that race.
 * One global Map, so `delete globalThis["__deepMemoryCachedHooks"]` still
 * invalidates everything; v1 hosts (one call, one directory) are unaffected.
 */
export const HOOKS_CACHE_KEY = "__deepMemoryCachedHooks";

export const deepMemoryPlugin: Plugin = async (input: PluginInput, options?: unknown): Promise<Hooks> => {
  const projectPath = input.directory;
  let memo = (globalThis as Record<string, unknown>)[HOOKS_CACHE_KEY] as
    | Map<string, Hooks | Promise<Hooks>>
    | undefined;
  if (!(memo instanceof Map)) {
    memo = new Map<string, Hooks | Promise<Hooks>>();
    (globalThis as Record<string, unknown>)[HOOKS_CACHE_KEY] = memo;
  }
  const existing = memo.get(projectPath);
  if (existing) return existing;

  const building = buildHooks(input, options);
  memo.set(projectPath, building);
  try {
    const hooks = await building;
    memo.set(projectPath, hooks);
    return hooks;
  } catch (err) {
    memo.delete(projectPath);
    throw err;
  }
};

async function buildHooks(input: PluginInput, options?: unknown): Promise<Hooks> {
  const projectPath = input.directory;

  const logger = createLogger();
  const state = createPluginState();
  const consolidation = resolveConsolidationConfig(options as ConsolidationOptions | undefined);

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

  const memoryTools = createMemoryTools(searchService, state, { projectPath, client: input.client, consolidation });

  const hooks: Hooks = {
    "chat.params": createChatParamsHandler(
      state,
      logger.for("chat-params"),
    ),

    "chat.message": createChatMessageHandler(
      state,
      logger.for("chat-message"),
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

        // v2 broadcasts every session event to every plugin instance, with the
        // owning location attached. Acting on a foreign location means spawning
        // consolidation for THIS project while someone works in another one —
        // with N projects that turns one idle into N consolidations. Events
        // without a location (v1 hosts) keep the old behaviour.
        const eventLocation = (event.properties as { locationDirectory?: string }).locationDirectory;
        if (typeof eventLocation === "string" && eventLocation.length > 0 && eventLocation !== projectPath) {
          return;
        }

        if (event.type === "session.idle") {
          const idleSessionID = (event.properties as { sessionID?: string }).sessionID;

          if (idleSessionID) {
            try {
              await handleIdleConsolidation(input.client, state, projectPath, idleSessionID, logger.for("idle-consolidation"), consolidation);
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
      consolidation,
    }),

    "experimental.chat.messages.transform": createMessagesTransformHandler(
      state,
      input.client,
      projectPath,
      logger.for("messages-transform"),
    ),
  };

  return hooks;
}

type IdleClient = {
  session: {
    messages: (args: { path: { id: string }; query?: { limit?: number } }) => Promise<{ data?: unknown[] }>;
    create: (args: {
      body: {
        parentID: string;
        title: string;
        /** Set at session level: v2 engines drop prompt-body `agent`. */
        agent?: string;
        model?: { providerID: string; modelID: string };
      };
      query: { directory: string };
    }) => Promise<{ data?: { id?: string } }>;
    promptAsync: (args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }>; agent: string } }) => Promise<unknown>;
  };
  /** Optional agent-listing face (v2 adapter / v1 SDK) used by the spawn precheck. */
  agent?: { list?: () => Promise<unknown> };
  app?: { agents?: () => Promise<unknown> };
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

/** Log+toast once when the failure budget is exhausted. Safe to call after every failure. */
async function maybeGiveUp(
  state: ReturnType<typeof createPluginState>,
  consolidation: ConsolidationConfig,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  client: IdleClient,
): Promise<void> {
  if (state.consolidationFailures() < consolidation.maxFailures) return;
  if (!state.markConsolidationGaveUpLogged()) return;
  logger.warn("idle consolidation: failure limit reached; disabled until restart", {
    failures: state.consolidationFailures(),
    maxFailures: consolidation.maxFailures,
  });
  await showToast(client, "▣ deep-memory | consolidation disabled until restart (repeated failures)", "warning");
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
  consolidation: ConsolidationConfig,
): Promise<void> {
  const typedClient = client as IdleClient;
  if (!typedClient?.session) return;
  if (!consolidation.enabled) return;

  // CRITICAL GUARD: never run consolidation on a session this plugin spawned.
  // The consolidation sub-session is created via client.session.create + promptAsync
  // with agent:"general". When it finishes, OpenCode emits session.idle for it.
  // Without this guard, the idle handler treats the sub-session like a normal one:
  //   consumePendingConsolidation(subID) → undefined (pending is keyed by PARENT id)
  //   shouldConsolidate() → true (MEMORY.md unchanged, counter unchanged)
  //   → spawn grand-sub-session + toast → infinite cascade, one toast per generation.
  // See markSubSessionSpawned() / isSpawnedSubSession() in shared-state.ts.
  if (state.isSpawnedSubSession(sessionID)) {
    logger.info("idle consolidation: skipping plugin-spawned sub-session", { sessionID });
    return;
  }

  const memPath = memoryFilePath("project", "memory", projectPath);
  if (!existsSyncSync(memPath)) return;

  const content = await readFile(memPath, "utf8");
  const memLines = content.split("\n").length;
  const memStat = statSync(memPath);

  const pending = state.peekPendingConsolidation(sessionID);
  if (pending) {
    // Re-poll semantics: a consolidation sub-session typically runs for minutes.
    // The old code consumed the pending entry on the FIRST idle tick and
    // silently lost any not-yet-finished result. Now: read the sub-session
    // state first and keep the pending entry while it is still running; consume
    // only on a terminal state (assistant text / error part) or when the entry
    // is older than consolidation.pendingTimeoutMs.
    let finished = false;
    let errorJson: string | undefined;
    let text: string | undefined;
    try {
      const resp = await typedClient.session.messages({ path: { id: pending.subSessionID }, query: { limit: 1 } });
      const msgs = resp.data ?? [];
      const last = msgs[msgs.length - 1] as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> } | undefined;
      if (last?.info?.role === "assistant") {
        const parts = last.parts ?? [];
        const errorPart = parts.find((p) => p.type === "error");
        if (errorPart) {
          finished = true;
          errorJson = JSON.stringify(errorPart);
        }
        for (const part of parts) {
          if (part.type === "text" && part.text) {
            text = part.text;
            finished = true;
            break;
          }
        }
      }
    } catch (err) {
      logger.warn("idle consolidation: failed to read sub-session", {
        subSessionID: pending.subSessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const aged = Date.now() - pending.setAt > consolidation.pendingTimeoutMs;
    if (!finished && !aged) return; // still running (or transient read error) — re-poll next idle

    // Terminal or aged: consume (one-shot, mirrored to disk) and resolve.
    state.consumePendingConsolidation(sessionID);
    state.persistPendingConsolidation(projectPath);

    if (!finished) {
      state.recordConsolidationFailure();
      logger.warn("idle consolidation: sub-session timed out", {
        subSessionID: pending.subSessionID,
        failures: state.consolidationFailures(),
      });
      await showToast(typedClient, `▣ deep-memory | consolidation timed out (${state.consolidationFailures()}/${consolidation.maxFailures})`, "warning");
      await maybeGiveUp(state, consolidation, logger, typedClient);
      return;
    }
    if (errorJson !== undefined) {
      state.recordConsolidationFailure();
      logger.warn("idle consolidation: sub-session LLM failed", {
        subSessionID: pending.subSessionID,
        error: errorJson,
        failures: state.consolidationFailures(),
      });
      await showToast(typedClient, `▣ deep-memory | consolidation failed (LLM error, ${state.consolidationFailures()}/${consolidation.maxFailures})`, "warning");
      await maybeGiveUp(state, consolidation, logger, typedClient);
      return;
    }
    if (text === undefined) {
      // Assistant message with neither a text nor an error part — previously a
      // silent fallthrough that lost the pending entry without a trace.
      state.recordConsolidationFailure();
      logger.warn("idle consolidation: assistant message had no text part", {
        subSessionID: pending.subSessionID,
        failures: state.consolidationFailures(),
      });
      await maybeGiveUp(state, consolidation, logger, typedClient);
      return;
    }

    const currentMtime = memStat.mtimeMs;
    if (currentMtime > pending.memMtime) {
      state.recordConsolidationFailure();
      await showToast(typedClient, "▣ deep-memory | consolidation discarded (mtime race)", "warning");
      logger.info("idle consolidation: discarded (mtime race)", { failures: state.consolidationFailures() });
      await maybeGiveUp(state, consolidation, logger, typedClient);
      return;
    }
    try {
      const release = await acquireLock(memPath);
      try {
        // Validate LLM output before writing (DCP #573 guard)
        const validation = validateConsolidation(content, text, { lines: memLines });
        if (!validation.ok) {
          state.recordConsolidationFailure();
          logger.warn("idle consolidation: rejected", {
            reason: validation.reason,
            failures: state.consolidationFailures(),
          });
          await showToast(typedClient, `▣ deep-memory | consolidation rejected (${validation.reason}; ${state.consolidationFailures()}/${consolidation.maxFailures})`, "warning");
          return;
        }
        const current = await readFile(memPath, "utf8");
        if (statSync(memPath).mtimeMs > pending.memMtime) {
          state.recordConsolidationFailure();
          await showToast(typedClient, "▣ deep-memory | consolidation discarded (mtime race)", "warning");
          logger.info("idle consolidation: discarded (mtime race, in lock)", { failures: state.consolidationFailures() });
          return;
        }
        const backupPath = memPath.replace("MEMORY.md", "MEMORY.bak.md");
        await writeFile(backupPath, current, "utf8");
        await writeFile(memPath, text, "utf8");
        const newLines = text.split("\n").length;
        state.recordConsolidationDone(newLines);
        await showToast(typedClient, `▣ deep-memory | memory consolidated: MEMORY.md (${newLines} lines / ${Math.round(text.length / 1024 * 10) / 10} KB)`);
        logger.info("idle consolidation: applied", { lines: newLines });
      } finally {
        release();
      }
    } catch (err) {
      state.recordConsolidationFailure();
      logger.warn("idle consolidation: failed to apply result", {
        error: err instanceof Error ? err.message : String(err),
        failures: state.consolidationFailures(),
      });
      await maybeGiveUp(state, consolidation, logger, typedClient);
    }
    return;
  }

  if (state.consolidationFailures() >= consolidation.maxFailures) {
    if (state.markConsolidationGaveUpLogged()) {
      logger.warn("idle consolidation: failure limit reached; disabled until restart", {
        failures: state.consolidationFailures(),
        maxFailures: consolidation.maxFailures,
      });
      await showToast(typedClient, "▣ deep-memory | consolidation disabled until restart (repeated failures)", "warning");
    }
    return;
  }

  if (!state.shouldConsolidate(memLines)) return;

  // DCP #439 cooldown: prevent rapid re-consolidation attempts
  if (!state.canStartConsolidation()) {
    logger.info("idle consolidation: cooldown active, skipping");
    return;
  }

  // Agent precheck: on hosts without the configured agent, a spawned sub-session
  // would run the host's default-agent chain instead (v2 engines drop the
  // prompt-body `agent` field entirely). Ask first, skip loudly.
  const agentPresent = await probeAgent(typedClient, consolidation.agent);
  if (agentPresent === false) {
    if (state.markConsolidationAgentMissingLogged()) {
      logger.warn("idle consolidation: agent not found on host; consolidation disabled", {
        agent: consolidation.agent,
      });
      await showToast(typedClient, `▣ deep-memory | consolidation skipped: agent "${consolidation.agent}" not found`, "warning");
    }
    return;
  }
  state.recordConsolidationAttempt();

  try {
    const model = state.bestModel();
    const resp = await typedClient.session.create({
      body: {
        parentID: sessionID,
        title: `Memory Consolidation ${new Date().toISOString().slice(0, 10)}`,
        agent: consolidation.agent,
        ...(model ? { model } : {}),
      },
      query: { directory: projectPath },
    });
    const subID = resp?.data?.id;
    if (!subID) {
      state.recordConsolidationFailure();
      logger.warn("idle consolidation: session.create returned no id", { failures: state.consolidationFailures() });
      await maybeGiveUp(state, consolidation, logger, typedClient);
      return;
    }

    const prompt = buildConsolidationPrompt(content, { lines: memLines, bytes: content.length });
    await typedClient.session.promptAsync({
      path: { id: subID },
      body: {
        parts: [{ type: "text", text: prompt }],
        agent: consolidation.agent,
        ...(model ? { model } : {}),
      },
    });

    state.setPendingConsolidation(sessionID, { subSessionID: subID, memMtime: memStat.mtimeMs });
    state.markSubSessionSpawned(subID);
    state.persistPendingConsolidation(projectPath);
    await showToast(typedClient, `▣ deep-memory | memory consolidation spawned (${consolidation.agent})`, "info", 3000);
    logger.info("idle consolidation: spawned", { subSessionID: subID, lines: memLines, agent: consolidation.agent });
  } catch (err) {
    state.recordConsolidationFailure();
    logger.warn("idle consolidation: failed to spawn", {
      error: err instanceof Error ? err.message : String(err),
      failures: state.consolidationFailures(),
    });
    await maybeGiveUp(state, consolidation, logger, typedClient);
  }

  // G5 cleanup: remove .tool-outputs/ files older than 7 days (best-effort)
  try {
    const toolOutputDir = path.join(projectMemoryDir(projectPath), ".tool-outputs");
    if (existsSyncSync(toolOutputDir)) {
      const entries = await readdir(toolOutputDir);
      const now = Date.now();
      let cleaned = 0;
      for (const entry of entries) {
        const filePath = path.join(toolOutputDir, entry);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          await unlink(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) logger.info("idle consolidation: cleaned old tool outputs", { cleaned });
    }
  } catch {
    // Cleanup is best-effort
  }
}

const pluginModule: PluginModule & { setup?: typeof v2Setup } = {
  id: "opencode-deep-memory",
  server: deepMemoryPlugin,
  setup: v2Setup,
};

export default pluginModule;

// v2 re-exports (batch D2): dual-form entry — v1 hosts keep calling the
// default (input) function; v2 hosts read .setup (E5-verified contract:
// {id, setup} -> disposer). See src/v2/entry.ts for the adapter semantics.
export { v2Setup, V2_PLUGIN_ID, buildV2Client } from "./v2/entry.js";
import { v2Setup } from "./v2/entry.js";
