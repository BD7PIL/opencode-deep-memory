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
import { estimateTokensSum } from "../shared/tokens.js";
import { readFile } from "node:fs/promises";
import { HANDOFF_PREFIX, STRUCTURED_COMPACTION_PROMPT } from "../extract/summarize.js";

/** Minimal client shape needed — avoids importing full PluginInput type. */
interface SessionClient {
  session: {
    messages(opts: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data: Array<{ info: unknown; parts: unknown[] }> | undefined }>;
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

      // Step 4: Signal that enrichment should run on next idle
      state.setPendingEnrichment(sessionID);

      // Step 5: Inject structured compaction prompt + handoff prefix
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
