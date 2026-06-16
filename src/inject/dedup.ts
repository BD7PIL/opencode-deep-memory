/**
 * Deduplicate items by Jaccard similarity using an inverted index.
 *
 * Instead of O(n²) pairwise comparisons, builds a token→entryIndex map
 * and only compares entries that share at least one token. Uses the same
 * Jaccard > threshold (default 0.85) for near-duplicate detection.
 */
export function dedupByJaccard<T>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.85,
): T[] {
  if (items.length === 0) return [];

  // Build token sets per item
  const tokenSets: Set<string>[] = items.map((item) => new Set(tokenize(getText(item))));

  // Build inverted index: token → list of item indices
  const inverted = new Map<string, number[]>();
  for (let i = 0; i < tokenSets.length; i++) {
    for (const token of tokenSets[i]!) {
      let list = inverted.get(token);
      if (!list) {
        list = [];
        inverted.set(token, list);
      }
      list.push(i);
    }
  }

  // Track which items are duplicates
  const isDuplicate = new Set<number>();
  const compared = new Set<string>();

  // Only compare entries sharing at least one token
  for (const indices of inverted.values()) {
    for (let a = 0; a < indices.length; a++) {
      const i = indices[a]!;
      if (isDuplicate.has(i)) continue;
      for (let b = a + 1; b < indices.length; b++) {
        const j = indices[b]!;
        if (isDuplicate.has(j)) continue;

        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (compared.has(key)) continue;
        compared.add(key);

        if (jaccardSimilarity(tokenSets[i]!, tokenSets[j]!) > threshold) {
          isDuplicate.add(j);
        }
      }
    }
  }

  return items.filter((_, i) => !isDuplicate.has(i));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((t) => t.length > 0);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
