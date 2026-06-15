export type Tier = 1 | 2 | 3 | 4 | 5;

const TIER_MAX_TOKENS: Record<number, number> = {
  1: 200,
  2: 60,
  3: 25,
  4: 15,
  5: 0,
};

/**
 * Render a memory entry at the given priority tier.
 *
 * - P1 (≤200t): full text, truncated to 800 chars if over budget
 * - P2 (≤60t):  first sentence + type label, max 200 chars
 * - P3 (≤25t):  first 10 words + type label, max 80 chars
 * - P4 (≤15t):  type label only
 * - P5:         empty string (skip)
 */
export function renderTier(
  content: string,
  type: string,
  heading: string,
  tier: Tier,
): string {
  if (tier === 5) return "";

  const maxTokens = TIER_MAX_TOKENS[tier];
  const contentTokens = Math.ceil(content.length / 4);

  // P1: full text (if fits)
  if (tier === 1) {
    return contentTokens <= maxTokens
      ? `- [${heading}] ${content}`
      : `- [${heading}] ${content.slice(0, maxTokens * 4)}... [truncated]`;
  }

  // P2: first sentence + type
  if (tier === 2) {
    const firstSentence = content.split(/[.。!！?？\n]/)[0] ?? content.slice(0, 200);
    return `- [${type}] ${firstSentence.slice(0, 200)}`;
  }

  // P3: type + first 10 words
  if (tier === 3) {
    const words = content.split(/\s+/).slice(0, 10).join(" ");
    return `- [${type}] ${words.slice(0, 80)}`;
  }

  // P4: type label only
  return `- [${type}]`;
}
