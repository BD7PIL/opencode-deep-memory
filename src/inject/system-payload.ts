/**
 * Compose the final system prompt fragment for adaptive memory injection.
 *
 * Reads MEMORY.md and checkpoint.md via budgetedRead, then wraps them
 * in XML tags for the system prompt.
 *
 * Uses hybrid injection:
 *   - Static (40% of memorySummary budget): Constraints + Rules from MEMORY.md
 *   - Context-aware (60% of memorySummary budget): BM25 search results for user's query
 */

import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import { memoryFilePath } from "../shared/paths.js";
import { truncateToTokenBudget } from "../shared/tokens.js";
import type { SearchService } from "../search/service.js";
import { classifyAgent, budgetFor } from "./agent-budget.js";
import { budgetedRead } from "./budgeted-read.js";

const TOOL_HINT =
  "Memory tools available: memory_search, memory_store, memory_forget. Guidelines: (1) Use memory_search to recall past decisions before re-deciding. (2) After encountering a tool error and fixing it, use memory_store with type=\"gotcha\" to save the error+fix pair. (3) When the user states a constraint or rule, use memory_store with type=\"constraint\".";

export interface ComposeSystemPayloadOpts {
  state: PluginState;
  sessionID: string | undefined;
  projectPath: string;
  mode: "normal" | "post-compaction" | "post-resume";
  searchService?: SearchService;
  userQuery?: string;
  logger?: Logger;
}

/**
 * Compose the system prompt payload for memory injection.
 *
 * Flow:
 * 1. Look up agent via state.agentOf(sessionID) → classify tier
 * 2. Get budget via budgetFor(tier, mode)
 * 3. If budget.total <= 80: tool-hint only (subagent tier)
 * 4. Split memorySummary budget: 40% static constraints, 60% context search
 * 5. Static: read Constraints + Rules + Decisions from MEMORY.md
 * 6. Context-aware: BM25 search for user's current query (when available)
 * 7. Read checkpoint.md at full checkpointSummary budget
 * 8. Compose final string with XML sections
 *
 * If budget.total <= 80 (tool-subagent tier), only emit the <tool-hint> fragment.
 */
export async function composeSystemPayload(opts: ComposeSystemPayloadOpts): Promise<string> {
  const { state, sessionID, projectPath, mode, searchService, userQuery, logger } = opts;

  // 1. Look up agent → classify tier
  const agent = sessionID ? state.agentOf(sessionID) : undefined;
  const tier = classifyAgent(agent);

  // 2. Get budget
  const budget = budgetFor(tier, mode);

  // 3. Tool-subagent: only emit tool hint
  if (budget.total <= 80) {
    return `<deep-memory>\n<tool-hint>${TOOL_HINT}</tool-hint>\n</deep-memory>`;
  }

  // 4. Split memory budget: 40% static constraints, 60% context search
  const staticBudget = Math.floor(budget.memorySummary * 0.4);
  const searchBudget = budget.memorySummary - staticBudget;

  // 5. Static: ALWAYS inject Constraints + Rules (hard rules regardless of context)
  let staticMemory = "";
  if (staticBudget > 0) {
    const memoryPath = memoryFilePath("project", "memory", projectPath);
    staticMemory = budgetedRead(memoryPath, staticBudget, [
      "Constraints",
      "Rules",
      "Decisions",
    ]);
  }

  // 6. Context-aware: search if query available
  let searchMemory = "";
  if (userQuery && searchService && searchBudget > 0) {
    try {
      const results = await searchService.search(userQuery, { scope: "all", limit: 5 });
      if (results.length > 0) {
        searchMemory = results.map((r) => {
          const scopeTag = r.scope === "global" ? "[global]" : r.scope === "session" ? "[session]" : "";
          return `- ${scopeTag}[${r.heading}] ${r.snippet.slice(0, 150)}`;
        }).join("\n");
        // Truncate to searchBudget
        searchMemory = truncateToTokenBudget(searchMemory, searchBudget);
      }
    } catch {
      /* fallback: leave searchMemory empty */
    }
  }

  // 7. Read checkpoint.md
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

  // 8. Compose output — combine static + context-aware memory
  let memoryContent = staticMemory || "(empty — no persistent memory yet)";
  if (searchMemory) {
    memoryContent += "\n\n## Relevant to your question\n" + searchMemory;
  }

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
