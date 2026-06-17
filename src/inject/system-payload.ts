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
  "Memory tools available: memory_search, memory_store, memory_forget, memory_expand, deep_expand. Guidelines:\n" +
  "  (1) BEFORE making ANY technical decision, search: memory_search(query=\"decision OR decided OR chose OR 选择 OR 决定\", scope=\"project\")\n" +
  "  (2) BEFORE fixing an error, search for known pitfalls: memory_search(query=\"gotcha OR error OR bug OR 坑 OR 错误\", scope=\"project\")\n" +
  "  (3) AFTER fixing an error, store it: memory_store(type=\"gotcha\", content=\"[error]: ... → [fix]: ...\", scope=\"project\")\n" +
  "  (4) WHEN user states a constraint/rule, store it: memory_store(type=\"constraint\", content=\"...\", scope=\"project\")\n" +
  "  (5) WHEN a technical decision is made, store it: memory_store(type=\"decision\", content=\"[decision]: ... → [reason]: ...\", scope=\"project\")";

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

export interface ComposeSystemPayloadResult {
  stable: string;
  volatile: string;
  stats: {
    searchEntries: number;
    repoMapEntries: number;
    hasCheckpoint: boolean;
  };
}

export async function composeSystemPayload(
  opts: ComposeSystemPayloadOpts,
): Promise<ComposeSystemPayloadResult> {
  const { state, sessionID, projectPath, mode, searchService, userQuery, logger, tracker } = opts;

  const agent = sessionID ? state.agentOf(sessionID) : undefined;
  const tier = classifyAgent(agent);
  const budget = budgetFor(tier, mode);

  if (budget.total <= 80) {
    return {
      stable: `<deep-memory-stable>\n<tool-hint>${TOOL_HINT}</tool-hint>\n</deep-memory-stable>`,
      volatile: "",
      stats: { searchEntries: 0, repoMapEntries: 0, hasCheckpoint: false },
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
  let searchEntries = 0;
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
        searchEntries = allocated.length;
        volatileContent = allocated.map((a) => a.rendered).join("\n");
      }
    } catch {
      // search failure is non-fatal
    }
  }

  let checkpointContent = "";
  let hasCheckpoint = false;
  if (budget.checkpointSummary > 0) {
    const checkpointPath = memoryFilePath("project", "checkpoint", projectPath);
    checkpointContent = budgetedRead(checkpointPath, budget.checkpointSummary, [
      "User Intent", "Decisions", "Constraints", "Gotchas", "File Changes",
    ]);
    hasCheckpoint = !!checkpointContent;
  }

  let volatile = `<deep-memory-volatile>\n<relevant>\n${volatileContent || "(none)"}\n</relevant>`;
  if (checkpointContent) {
    volatile += `\n<last-checkpoint>\n${checkpointContent}\n</last-checkpoint>`;
  }

  let repoMapSymbols = 0;
  if (tracker && budget.repomap > 0) {
    const repomapEntries = tracker.getTopSymbols(budget.repomap);
    if (repomapEntries.length > 0) {
      repoMapSymbols = repomapEntries.length;
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

  return { stable, volatile, stats: { searchEntries, repoMapEntries: repoMapSymbols, hasCheckpoint } };
}
