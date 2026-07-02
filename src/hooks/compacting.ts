/**
 * Compacting hook — captures conversation and extracts knowledge before compaction.
 *
 * This hook is called by OpenCode just before it compacts a session (destroys
 * older messages). It runs synchronously-blocking (the host awaits it) and
 * MUST NOT throw — any error is caught and logged.
 *
 * Pipeline: capture messages → extract heuristics → render + write checkpoint.md
 *
 * See DESIGN.md §5.1, §5.2 (Instant Layer), §7.1 (compacting row).
 */

import type { Logger } from "../shared/log.js";
import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { RepoMapTracker } from "../repomap/tracker.js";
import { captureMessages } from "../extract/capture.js";
import { extractHeuristics } from "../extract/heuristics.js";
import { renderCheckpoint, writeCheckpoint } from "../extract/checkpoint-writer.js";
import { consolidateMemory, buildConsolidationPrompt } from "../extract/consolidate.js";
import { estimateTokensSum } from "../shared/tokens.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { acquireLock } from "../shared/lock.js";
import { memoryFilePath } from "../shared/paths.js";
import { HANDOFF_PREFIX, STRUCTURED_COMPACTION_PROMPT } from "../extract/summarize.js";

/** Minimal client shape needed — avoids importing full PluginInput type. */
interface SessionClient {
  session: {
    messages(opts: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data: Array<{ info: unknown; parts: unknown[] }> | undefined }>;
    create(opts: {
      body: { parentID: string; title: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    promptAsync(opts: { path: { id: string }; body: { parts: unknown[]; agent?: string } }): Promise<unknown>;
  };
}

export interface CompactingHandlerArgs {
  client: SessionClient;
  state: PluginState;
  projectPath: string;
  logger?: Logger;
  tracker?: RepoMapTracker;
}

/**
 * Factory that creates the experimental.session.compacting hook handler.
 *
 * Returns an async function matching the exact SDK hook signature:
 *   (input: { sessionID }, output: { context, prompt? }) => Promise<void>
 */
export function createCompactingHandler(
  args: CompactingHandlerArgs,
): NonNullable<Hooks["experimental.session.compacting"]> {
  const { client, state, projectPath, logger, tracker } = args;

  return async (input, output) => {
    const { sessionID } = input;

    try {
      // Step 1: Capture raw messages
      logger?.info("compacting hook: capturing messages", { sessionID });
      const capture = await captureMessages({ client, sessionID, projectPath, logger });

      if (capture.messageCount === 0) {
        logger?.warn("compacting hook: no messages captured, skipping extraction", {
          sessionID,
        });
        return;
      }

      // Step 2: Read raw messages back and extract heuristics
      let rawMessages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string; tool?: string; args?: Record<string, unknown>; output?: unknown; state?: { status?: string; output?: string; error?: string } }> }>;
      try {
        const raw = await readFile(capture.rawFilePath, "utf-8");
        const parsed = JSON.parse(raw) as { messages: typeof rawMessages };
        rawMessages = parsed.messages;
      } catch (readErr) {
        logger?.warn("compacting hook: failed to read raw checkpoint", {
          sessionID,
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
        return;
      }

      const result = extractHeuristics(rawMessages);

      // Step 3: Render and write checkpoint.md
      const tokenEstimate = estimateTokensSum(result.userIntents);

      let foldedContext: string | undefined;
      if (tracker) {
        const recentFiles = tracker.getRecentlyRead(10);
        if (recentFiles.length > 0) {
          foldedContext = recentFiles.map(f =>
            `${f.path}:\n  ${f.symbols.slice(0, 10).map(s => s.name).join(", ")}`
          ).join("\n");
        }
      }

      const markdown = renderCheckpoint({ sessionID, tokenEstimate, result, foldedContext });
      const checkpointPath = await writeCheckpoint({
        projectPath,
        sessionID,
        content: markdown,
        logger,
      });

      // Step 4: Auto-consolidate MEMORY.md — SimHash dedup only (no stale purge during compaction)
      try {
        const memPath = memoryFilePath("project", "memory", projectPath);
        if (existsSync(memPath)) {
          const release = await acquireLock(memPath);
          try {
            const content = await readFile(memPath, "utf8");
            const consolidated = consolidateMemory(content);
            if (consolidated !== content) {
              await writeFile(memPath, consolidated, "utf8");
              logger?.info("compacting: consolidated MEMORY.md", {
                beforeBytes: content.length,
                afterBytes: consolidated.length,
                diff: content.length - consolidated.length,
              });
            }
          } finally {
            release();
          }
        }
      } catch (err) {
        logger?.warn("compacting: consolidate failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 4b: Check pending LLM consolidation sub-session result
      const pendingConsolidation = state.consumePendingConsolidation(sessionID);
      if (pendingConsolidation) {
        try {
          const memPath = memoryFilePath("project", "memory", projectPath);
          if (existsSync(memPath)) {
            const currentMtime = (await import("node:fs")).statSync(memPath).mtimeMs;
            if (currentMtime > pendingConsolidation.memMtime) {
              logger?.info("compacting: MEMORY.md changed since consolidation start, discarding LLM result");
            } else {
              const resp = await client.session.messages({ path: { id: pendingConsolidation.subSessionID }, query: { limit: 1 } });
              const msgs = resp.data ?? [];
              const lastAssistantMsg = msgs[msgs.length - 1];
              if (lastAssistantMsg) {
                for (const part of lastAssistantMsg.parts) {
                  const p = part as { type?: string; text?: string };
                  if (p.type === "text" && p.text) {
                    const release = await acquireLock(memPath);
                    try {
                      const current = await readFile(memPath, "utf8");
                      const currentStat = (await import("node:fs")).statSync(memPath);
                      if (currentStat.mtimeMs > pendingConsolidation.memMtime) {
                        logger?.info("compacting: MEMORY.md changed, discarding LLM consolidation result");
                      } else {
                        const backupPath = memPath.replace("MEMORY.md", "MEMORY.bak.md");
                        await writeFile(backupPath, current, "utf8");
                        await writeFile(memPath, p.text, "utf8");
                        logger?.info("compacting: LLM consolidation applied", {
                          beforeBytes: current.length,
                          afterBytes: p.text.length,
                        });
                      }
                    } finally { release(); }
                    break;
                  }
                }
              }
            }
          }
        } catch (err) {
          logger?.warn("compacting: LLM consolidation extraction failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      state.persistPendingConsolidation(projectPath);

      // Step 4c: If MEMORY.md is large enough, start new LLM consolidation sub-session
      if (!pendingConsolidation) {
        try {
          const memPath = memoryFilePath("project", "memory", projectPath);
          if (existsSync(memPath)) {
            const content = await readFile(memPath, "utf8");
            const lineCount = content.split("\n").length;
            if (lineCount > 50) {
              try {
                const resp = await client.session.create({
                  body: { parentID: sessionID, title: `Memory Consolidation ${new Date().toISOString().slice(0, 10)}` },
                  query: { directory: projectPath },
                });
                const subID = (resp as { data?: { id: string } })?.data?.id;
                if (subID) {
                  const prompt = buildConsolidationPrompt(content);
                  await client.session.promptAsync({
                    path: { id: subID },
                    body: { parts: [{ type: "text", text: prompt }], agent: "general" },
                  });
                  const memStat = (await import("node:fs")).statSync(memPath);
                  state.setPendingConsolidation(sessionID, { subSessionID: subID, memMtime: memStat.mtimeMs });
                  state.persistPendingConsolidation(projectPath);
                  logger?.info("compacting: spawned LLM consolidation sub-session", {
                    subSessionID: subID, lines: lineCount,
                  });
                }
              } catch (spawnErr) {
                logger?.warn("compacting: failed to spawn consolidation sub-session", {
                  error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
                });
              }
            }
          }
        } catch (err) {
          logger?.debug("compacting: no MEMORY.md to consolidate", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Step 5: Signal PostCompact nudge on next messages.transform
      state.setPendingPostCompactNudge(sessionID);

      // Step 6: Inject structured compaction prompt + handoff prefix
      // Only on sessions with enough messages to justify structured summary
      if (capture.messageCount >= 20) {
        output.prompt = STRUCTURED_COMPACTION_PROMPT;
      }
      output.context.push(HANDOFF_PREFIX);
      output.context.push(
        `Prior conversation archived to ${checkpointPath}`,
      );

      logger?.info("compacting hook: checkpoint written", {
        sessionID,
        checkpointPath,
        intents: result.userIntents.length,
        decisions: result.decisions.length,
        constraints: result.constraints.length,
        gotchas: result.gotchas.length,
        fileChanges: result.fileChanges.length,
      });
    } catch (err) {
      // NEVER throw — would block the compaction process
      logger?.error("compacting hook failed (swallowed)", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
