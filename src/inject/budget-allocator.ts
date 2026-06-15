import { computeImportance } from "./importance.js";
import { renderTier, type Tier } from "./tier-renderer.js";
import { estimateTokens } from "../shared/tokens.js";

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

/**
 * Single-pass greedy budget allocation with BM25 × importance fusion.
 *
 * 1. Compute BM25 percentile thresholds (top 20%, top 50%)
 * 2. Fuse base importance + BM25 boost per result
 * 3. Sort by fused importance desc
 * 4. Greedy: try P1→P2→P3→P4→break
 * 5. Render at allocated tier, subtract tokens
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

  // 1. Compute BM25 percentile boost
  const sortedScores = results.map((r) => r.score).sort((a, b) => b - a);
  const top20 = sortedScores[Math.floor(sortedScores.length * 0.2)] ?? 0;
  const top50 = sortedScores[Math.floor(sortedScores.length * 0.5)] ?? 0;

  // 2. Compute fused importance for each
  const withImportance = results.map((r) => {
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

  // 3. Sort by fused importance descending
  withImportance.sort((a, b) => b.fusedImportance - a.fusedImportance);

  // 4. Single-pass greedy allocation
  let remaining = opts.budget;
  const allocated: AllocatedEntry[] = [];

  for (const item of withImportance) {
    if (remaining <= 0) break;

    const content = item.result.snippet;
    const fullCost = estimateTokens(content);

    let tier: Tier;
    if (fullCost <= remaining && item.fusedImportance >= 80) {
      tier = 1;
    } else if (remaining > 60) {
      tier = 2;
    } else if (remaining > 25) {
      tier = 3;
    } else if (remaining > 15) {
      tier = 4;
    } else {
      break;
    }

    const rendered = renderTier(content, item.type, item.result.heading, tier);
    const tokens = estimateTokens(rendered);

    allocated.push({
      content,
      type: item.type,
      heading: item.result.heading,
      tier,
      rendered,
      tokens,
    });
    remaining -= tokens;
  }

  return allocated;
}

function inferType(heading: string): string {
  const h = heading.toLowerCase();
  if (h.includes("constraint") || h.includes("rule")) return "constraint";
  if (h.includes("decision")) return "decision";
  if (h.includes("gotcha") || h.includes("error")) return "gotcha";
  if (h.includes("fact")) return "fact";
  return "note";
}
