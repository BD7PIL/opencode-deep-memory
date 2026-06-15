/**
 * Cheap token estimator. Uses ~4 chars/token heuristic.
 *
 * This is intentionally simple — exact tokenization requires the model's
 * tokenizer (e.g., tiktoken for OpenAI), which is too heavy for a hot path.
 * The 4 chars/token heuristic is accurate within ±15% for English and
 * slightly pessimistic for CJK (which is ~1.5 chars/token, so we over-count).
 */

const CHARS_PER_TOKEN = 4;

/** Estimate the token count of a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ceil so we never under-budget
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for a list of strings (sum). */
export function estimateTokensSum(parts: string[]): number {
  let total = 0;
  for (const p of parts) total += estimateTokens(p);
  return total;
}

/** Truncate text to fit within a token budget. */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) return "";
  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  // Try to cut at a paragraph or sentence boundary for readability.
  const cut = text.slice(0, maxChars);
  const lastPara = cut.lastIndexOf("\n\n");
  if (lastPara > maxChars * 0.5) return cut.slice(0, lastPara) + "\n\n[truncated]";
  const lastSentence = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("。"),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  if (lastSentence > maxChars * 0.5) return cut.slice(0, lastSentence + 1) + " [truncated]";
  return cut + " [truncated]";
}
