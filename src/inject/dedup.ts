/**
 * Deduplicate items by Jaccard similarity of their tokenized text.
 *
 * Greedy: iterate items in order, skip if similar (above threshold) to any
 * already-kept item. Default threshold 0.85 catches near-duplicates only.
 */
export function dedupByJaccard<T>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.85,
): T[] {
  const result: T[] = [];
  const tokenSets: Set<string>[] = [];

  for (const item of items) {
    const tokens = new Set(tokenize(getText(item)));
    let isDup = false;

    for (const existing of tokenSets) {
      if (jaccardSimilarity(tokens, existing) > threshold) {
        isDup = true;
        break;
      }
    }

    if (!isDup) {
      result.push(item);
      tokenSets.push(tokens);
    }
  }

  return result;
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
