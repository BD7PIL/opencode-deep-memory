const BASE_IMPORTANCE: Record<string, number> = {
  constraint: 80,
  decision: 70,
  gotcha: 60,
  fact: 50,
  note: 30,
};

export interface ImportanceFactors {
  type: string;
  ageDays: number;
  notesOccurrences: number;
  searchHits: number;
  /** Entry content text — used for Aider-style multipliers (optional for backward compat). */
  content?: string;
  /** Entry heading — used for generic-word demotion (optional for backward compat). */
  heading?: string;
}

const COMMON_WORDS = [
  "test",
  "util",
  "helper",
  "config",
  "index",
  "main",
  "init",
  "setup",
];

/**
 * Compute a 1-100 importance score from heuristic factors.
 *
 * Base score from type → +frequency bonus (capped 20) → +searchHits bonus
 * (capped 15) → +recency bonus (10 if <7d, 5 if <30d) → Aider-style
 * multipliers (private demotion, long-content boost, generic-word demotion)
 * → clamp 1-100.
 */
export function computeImportance(factors: ImportanceFactors): number {
  let score = BASE_IMPORTANCE[factors.type] ?? 40;
  score += Math.min(20, factors.notesOccurrences * 5);
  score += Math.min(15, factors.searchHits * 5);
  if (factors.ageDays < 7) score += 10;
  else if (factors.ageDays < 30) score += 5;

  // Aider-style multipliers (C2 optimization)
  const content = factors.content ?? "";
  const heading = factors.heading ?? "";

  if (content.startsWith("_") || heading.startsWith("_")) {
    score *= 0.3; // private/internal demoted
  }
  if (content.length >= 50) {
    score *= 1.3; // detailed entries promoted (like Aider's long identifier boost)
  }
  const headingLower = heading.toLowerCase();
  if (COMMON_WORDS.some((w) => headingLower.includes(w))) {
    score *= 0.5; // generic entries demoted
  }

  return Math.max(1, Math.min(100, Math.round(score)));
}
