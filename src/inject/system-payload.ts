/**
 * Compose the final system prompt fragment for adaptive memory injection.
 *
 * Reads MEMORY.md and checkpoint.md via budgetedRead, then wraps them
 * in XML tags for the system prompt.
 */

import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import { memoryFilePath } from "../shared/paths.js";
import { classifyAgent, budgetFor } from "./agent-budget.js";
import { budgetedRead } from "./budgeted-read.js";

const TOOL_HINT =
  "Memory tools available: memory_search, memory_store, memory_forget. Guidelines: (1) Use memory_search to recall past decisions before re-deciding. (2) After encountering a tool error and fixing it, use memory_store with type=\"gotcha\" to save the error+fix pair. (3) When the user states a constraint or rule, use memory_store with type=\"constraint\".";

export interface ComposeSystemPayloadOpts {
  state: PluginState;
  sessionID: string | undefined;
  projectPath: string;
  mode: "normal" | "post-compaction" | "post-resume";
  logger?: Logger;
}

/**
 * Compose the system prompt payload for memory injection.
 *
 * Flow:
 * 1. Look up agent via state.agentOf(sessionID) → classify tier
 * 2. Get budget via budgetFor(tier, mode)
 * 3. If budget.memorySummary > 0: read project MEMORY.md via budgetedRead
 * 4. If budget.checkpointSummary > 0: read project checkpoint.md via budgetedRead
 * 5. Compose final string with XML sections
 *
 * If budget.total <= 80 (tool-subagent tier), only emit the <tool-hint> fragment.
 */
export function composeSystemPayload(opts: ComposeSystemPayloadOpts): string {
  const { state, sessionID, projectPath, mode, logger } = opts;

  // 1. Look up agent → classify tier
  const agent = sessionID ? state.agentOf(sessionID) : undefined;
  const tier = classifyAgent(agent);

  // 2. Get budget
  const budget = budgetFor(tier, mode);

  // 3. Tool-subagent: only emit tool hint
  if (budget.total <= 80) {
    return `<deep-memory>\n<tool-hint>${TOOL_HINT}</tool-hint>\n</deep-memory>`;
  }

  // 4. Read MEMORY.md
  let memorySummary = "";
  if (budget.memorySummary > 0) {
    const memoryPath = memoryFilePath("project", "memory", projectPath);
    memorySummary = budgetedRead(memoryPath, budget.memorySummary, [
      "Rules",
      "Constraints",
      "Decisions",
      "Gotchas",
      "Facts",
    ]);
  }

  // 5. Read checkpoint.md
  let checkpointSummary = "";
  if (budget.checkpointSummary > 0) {
    const checkpointPath = memoryFilePath("project", "checkpoint", projectPath);
    checkpointSummary = budgetedRead(checkpointPath, budget.checkpointSummary, [
      "User Intent",
      "Decisions",
      "Constraints",
      "Gotchas",
      "File Changes",
    ]);
  }

  // 6. Compose output
  const memoryContent = memorySummary || "(empty — no persistent memory yet)";

  let payload = `<deep-memory>\n<tool-hint>${TOOL_HINT}</tool-hint>\n<persistent-memory>\n${memoryContent}\n</persistent-memory>`;

  if (checkpointSummary) {
    payload += `\n<last-checkpoint>\n${checkpointSummary}\n</last-checkpoint>`;
  }

  payload += `\n</deep-memory>`;

  logger?.debug("composeSystemPayload", {
    agent: agent ?? "(undefined)",
    tier,
    mode,
    payloadSize: payload.length,
  });

  return payload;
}
