import { computeImportance } from "./importance.js";
import { renderTier, type Tier } from "./tier-renderer.js";

export interface SearchResultLike {
  score: number;
  heading: string;
  snippet: string;
  scope: string;
}

export interface AllocatedEntry {
  content: string;
  type: string;
  heading: string;
  tier: Tier;
  rendered: string;
  tokens: number;
}

interface EntryWithImportance {
  result: SearchResultLike;
  type: string;
  fusedImportance: number;
}

const TIER_COST: Record<number, number> = { 1: 200, 2: 60, 3: 25, 4: 15 };

/**
 * Two-phase tier-first budget allocation with BM25 × importance fusion.
 *
 * Phase 1 (Floor): Render all entries at P4 (15 tokens). If total P4 cost
 *   exceeds budget, select top-N by importance and drop the rest.
 * Phase 2 (Upgrade): With remaining budget, greedily upgrade the highest
 *   importance entries through P4→P3→P2→P1.
 */
export function allocateAndRender(
  results: SearchResultLike[],
  opts: {
    budget: number;
    ageDays?: (entry: SearchResultLike) => number;
    typeOf?: (entry: SearchResultLike) => string;
  },
): AllocatedEntry[] {
  if (results.length === 0) return [];

  // Compute BM25 percentile boost
  const sortedScores = results.map((r) => r.score).sort((a, b) => b - a);
  const top20 = sortedScores[Math.floor(sortedScores.length * 0.2)] ?? 0;
  const top50 = sortedScores[Math.floor(sortedScores.length * 0.5)] ?? 0;

  // Compute fused importance for each
  const withImportance: EntryWithImportance[] = results.map((r) => {
    const type = opts.typeOf?.(r) ?? inferType(r.heading);
    const ageDays = opts.ageDays?.(r) ?? 0;
    const base = computeImportance({
      type,
      ageDays,
      notesOccurrences: 0,
      searchHits: 0,
    });
    let boost = 0;
    if (r.score >= top20) boost = 30;
    else if (r.score >= top50) boost = 15;
    return { result: r, type, fusedImportance: base + boost };
  });

  // Sort by fused importance descending
  withImportance.sort((a, b) => b.fusedImportance - a.fusedImportance);

  // Phase 1: Floor at P4
  const maxAtP4 = Math.floor(opts.budget / TIER_COST[4]);
  const selected = withImportance.slice(0, maxAtP4);
  let remaining = opts.budget - selected.length * TIER_COST[4];

  const allocations: AllocatedEntry[] = selected.map((item) => {
    const rendered = renderTier(item.result.snippet, item.type, item.result.heading, 4);
    return {
      content: item.result.snippet,
      type: item.type,
      heading: item.result.heading,
      tier: 4 as Tier,
      rendered,
      tokens: TIER_COST[4],
    };
  });

  // Phase 2: Greedy upgrade by importance (using fixed tier cost differences)
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i]!;
    // Try P4→P3 (costs 10 more tokens)
    if (remaining >= TIER_COST[3] - TIER_COST[4] && alloc.tier === 4) {
      alloc.tier = 3;
      alloc.rendered = renderTier(alloc.content, alloc.type, alloc.heading, 3);
      alloc.tokens = TIER_COST[3];
      remaining -= TIER_COST[3] - TIER_COST[4];
    }
    // Try P3→P2 (costs 35 more tokens)
    if (remaining >= TIER_COST[2] - TIER_COST[3] && alloc.tier === 3) {
      alloc.tier = 2;
      alloc.rendered = renderTier(alloc.content, alloc.type, alloc.heading, 2);
      alloc.tokens = TIER_COST[2];
      remaining -= TIER_COST[2] - TIER_COST[3];
    }
    // Try P2→P1 (costs 140 more tokens)
    if (remaining >= TIER_COST[1] - TIER_COST[2] && alloc.tier === 2) {
      alloc.tier = 1;
      alloc.rendered = renderTier(alloc.content, alloc.type, alloc.heading, 1);
      alloc.tokens = TIER_COST[1];
      remaining -= TIER_COST[1] - TIER_COST[2];
    }
  }

  return allocations;
}

function inferType(heading: string): string {
  const h = heading.toLowerCase();
  if (h.includes("constraint") || h.includes("rule")) return "constraint";
  if (h.includes("decision")) return "decision";
  if (h.includes("gotcha") || h.includes("error")) return "gotcha";
  if (h.includes("fact")) return "fact";
  return "note";
}
