/**
 * Compose the system prompt for m[0]/m[1] cache-stable injection.
 *
 * m[0] (stable): TOOL_HINT + Constraints from MEMORY.md — never changes per turn
 * m[1] (volatile): Tier-allocated BM25 search results — changes per turn
 *
 * OpenCode preserves n[0] reference identity for cache, so pushing stable
 * first means the cache prefix survives across turns.
 */

import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import { memoryFilePath } from "../shared/paths.js";
import type { SearchService } from "../search/service.js";
import { classifyAgent, budgetFor } from "./agent-budget.js";
import { budgetedRead } from "./budgeted-read.js";
import { allocateAndRender } from "./budget-allocator.js";
import { dedupByJaccard } from "./dedup.js";
import type { RepoMapTracker } from "../repomap/tracker.js";
import { formatRepoMap } from "../repomap/injector.js";

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
  tracker?: RepoMapTracker;
}

export async function composeSystemPayload(
  opts: ComposeSystemPayloadOpts,
): Promise<{ stable: string; volatile: string }> {
  const { state, sessionID, projectPath, mode, searchService, userQuery, logger, tracker } = opts;

  const agent = sessionID ? state.agentOf(sessionID) : undefined;
  const tier = classifyAgent(agent);
  const budget = budgetFor(tier, mode);

  if (budget.total <= 80) {
    return {
      stable: `<deep-memory-stable>\n<tool-hint>${TOOL_HINT}</tool-hint>\n</deep-memory-stable>`,
      volatile: "",
    };
  }

  const staticBudget = Math.floor(budget.memorySummary * 0.4);
  const searchBudget = budget.memorySummary - staticBudget;

  let staticMemory = "";
  if (staticBudget > 0) {
    const memoryPath = memoryFilePath("project", "memory", projectPath);
    staticMemory = budgetedRead(memoryPath, staticBudget, ["Constraints", "Rules", "Decisions"]);
  }

  const stable = `<deep-memory-stable>\n<tool-hint>${TOOL_HINT}</tool-hint>\n<constraints>\n${staticMemory || "(empty)"}\n</constraints>\n</deep-memory-stable>`;

  let volatileContent = "";
  if (userQuery && searchService && searchBudget > 0) {
    try {
      const results = await searchService.search(userQuery, { scope: "all", limit: 20, applyDecay: true });
      if (results.length > 0) {
        const deduped = dedupByJaccard(results, (r) => r.snippet);
        const allocated = allocateAndRender(
          deduped.map((r) => ({
            score: r.score,
            heading: r.heading,
            snippet: r.snippet,
            scope: r.scope,
          })),
          { budget: searchBudget },
        );
        volatileContent = allocated.map((a) => a.rendered).join("\n");
      }
    } catch {
      // search failure is non-fatal
    }
  }

  let checkpointContent = "";
  if (budget.checkpointSummary > 0) {
    const checkpointPath = memoryFilePath("project", "checkpoint", projectPath);
    checkpointContent = budgetedRead(checkpointPath, budget.checkpointSummary, [
      "User Intent", "Decisions", "Constraints", "Gotchas", "File Changes",
    ]);
  }

  let volatile = `<deep-memory-volatile>\n<relevant>\n${volatileContent || "(none)"}\n</relevant>`;
  if (checkpointContent) {
    volatile += `\n<last-checkpoint>\n${checkpointContent}\n</last-checkpoint>`;
  }

  if (tracker && budget.repomap > 0) {
    const repomapEntries = tracker.getTopSymbols(budget.repomap);
    if (repomapEntries.length > 0) {
      volatile += "\n" + formatRepoMap(repomapEntries);
    }
  }

  volatile += `\n</deep-memory-volatile>`;

  logger?.debug("composeSystemPayload", {
    agent: agent ?? "(undefined)",
    tier,
    mode,
    stableSize: stable.length,
    volatileSize: volatile.length,
  });

  return { stable, volatile };
}
