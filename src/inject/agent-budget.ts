/**
 * Per-agent budget policy for adaptive injection.
 *
 * Agents are classified into tiers, each with different token budgets
 * for memory injection. Budgets vary by mode (normal, post-compaction, post-resume).
 */

export type AgentTier = "main" | "deep-reasoning" | "tool-subagent";

/**
 * Classify an agent name into a tier.
 *
 * Main: undefined, "build", "sisyphus", "open-craft", "opencode"
 * Deep-reasoning: "oracle", "metis", "momus"
 * Tool-subagent: "explore", "librarian", "quick", "task", "Sisyphus-Junior", "general"
 * Default for unknown: "main" (safer to over-inject than under-inject)
 */
export function classifyAgent(agent: string | undefined): AgentTier {
  if (agent === undefined) return "main";

  const lower = agent.toLowerCase();

  // Main orchestrators
  const mainAgents = ["build", "sisyphus", "open-craft", "opencode"];
  if (mainAgents.includes(lower)) return "main";

  // Deep reasoning
  const deepAgents = ["oracle", "metis", "momus"];
  if (deepAgents.includes(lower)) return "deep-reasoning";

  // Tool subagents
  const toolAgents = [
    "explore",
    "librarian",
    "quick",
    "task",
    "sisyphus-junior",
    "general",
  ];
  if (toolAgents.includes(lower)) return "tool-subagent";

  // Unknown agent → default to main (safer to over-inject)
  return "main";
}

export interface Budget {
  total: number;
  toolPrompt: number;
  memorySummary: number;
  checkpointSummary: number;
  repomap: number;
}

const BUDGET_TABLE: Record<AgentTier, Record<string, Budget>> = {
  main: {
    normal: { total: 800, toolPrompt: 80, memorySummary: 400, checkpointSummary: 220, repomap: 100 },
    "post-compaction": { total: 3000, toolPrompt: 80, memorySummary: 1200, checkpointSummary: 1420, repomap: 300 },
    "post-resume": { total: 3000, toolPrompt: 80, memorySummary: 1200, checkpointSummary: 1420, repomap: 300 },
  },
  "deep-reasoning": {
    normal: { total: 400, toolPrompt: 80, memorySummary: 240, checkpointSummary: 80, repomap: 0 },
    "post-compaction": { total: 800, toolPrompt: 80, memorySummary: 500, checkpointSummary: 220, repomap: 0 },
    "post-resume": { total: 400, toolPrompt: 80, memorySummary: 240, checkpointSummary: 80, repomap: 0 },
  },
  "tool-subagent": {
    normal: { total: 80, toolPrompt: 80, memorySummary: 0, checkpointSummary: 0, repomap: 0 },
    "post-compaction": { total: 80, toolPrompt: 80, memorySummary: 0, checkpointSummary: 0, repomap: 0 },
    "post-resume": { total: 80, toolPrompt: 80, memorySummary: 0, checkpointSummary: 0, repomap: 0 },
  },
};

/**
 * Get the token budget for a given agent tier and mode.
 */
export function budgetFor(
  tier: AgentTier,
  mode: "normal" | "post-compaction" | "post-resume",
): Budget {
  return BUDGET_TABLE[tier][mode];
}
