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
}

/**
 * Compute a 1-100 importance score from heuristic factors.
 *
 * Base score from type → +frequency bonus (capped 20) → +searchHits bonus
 * (capped 15) → +recency bonus (10 if <7d, 5 if <30d) → clamp 1-100.
 */
export function computeImportance(factors: ImportanceFactors): number {
  let score = BASE_IMPORTANCE[factors.type] ?? 40;
  score += Math.min(20, factors.notesOccurrences * 5);
  score += Math.min(15, factors.searchHits * 5);
  if (factors.ageDays < 7) score += 10;
  else if (factors.ageDays < 30) score += 5;
  return Math.max(1, Math.min(100, score));
}
