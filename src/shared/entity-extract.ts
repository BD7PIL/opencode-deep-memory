/**
 * Entity extraction + boosted retrieval (G2 Mem0 pattern).
 *
 * Extracts entity tokens (file names, function names, version numbers, PascalCase
 * identifiers) from text. At search time, results matching query entities get
 * a score boost (Mem0's ENTITY_BOOST_WEIGHT pattern).
 *
 * Zero new dependencies — uses regex only.
 */

const ENTITY_PATTERNS: RegExp[] = [
  // File names: consolidate.ts, WLG5144.py, index.js
  /\b[A-Za-z_][\w-]*\.(?:ts|js|py|go|rs|java|md|json|yaml|yml|sh)\b/g,
  // Function calls: buildPrompt(), handleIdleConsolidation()
  /\b[a-z_][a-zA-Z0-9_]*\(\)/g,
  // Version numbers: 3.6.8, 0.11.4, 1.2.3-beta
  /\b\d+\.\d+\.\d+(?:-\w+)?\b/g,
  // PascalCase identifiers: WLG5144, OpenShortPlus, SimHash (3+ uppercase letters or uppercase-start)
  /\b[A-Z][a-zA-Z0-9_-]{2,}\b/g,
];

// Common English stopwords to filter (avoids false entity matches on "The", "This", etc.)
const STOPWORDS = new Set([
  "the", "this", "that", "these", "those", "there", "their", "them",
  "what", "when", "where", "which", "while", "with", "without",
  "your", "yours", "you", "yourself",
  "all", "any", "are", "and", "but", "for", "from", "has", "have",
  "not", "use", "using", "used", "was", "were", "will", "would",
  "can", "could", "should", "must", "into", "some", "such", "than",
  "then", "they", "about", "above", "after", "before", "being",
  "between", "both", "each", "more", "most", "other", "over",
  "same", "very", "just", "only", "also", "here", "how", "why",
]);

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const raw = match[0];
      // Filter: too short (<3 chars after trimming extension)
      if (raw.length < 3) continue;
      // Filter: pure stopwords
      if (STOPWORDS.has(raw.toLowerCase())) continue;
      entities.add(raw.toLowerCase());
    }
  }
  return [...entities];
}

/**
 * Compute Jaccard overlap between two sets of entity tokens.
 * Returns 0-1 ratio of shared entities.
 */
export function entityOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const e of setA) {
    if (setB.has(e)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/** Entity boost weight (Mem0 pattern: matching entities get 1.5x score multiplier). */
export const ENTITY_BOOST_WEIGHT = 1.5;
