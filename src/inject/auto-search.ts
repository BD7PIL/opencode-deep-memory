/**
 * D2: Synchronous auto-search whisper. Runs in-hook (system.transform).
 * Triggers when top-1 BM25 score >= 2.0 (absolute) AND top-20 percentile (relative).
 * See DESIGN_V4.md D2.
 */

import type { SearchResult } from "../search/service.js";

export const WHISPER_MIN_SCORE = 2.0;

export function shouldWhisper(results: SearchResult[]): boolean {
  if (results.length === 0) return false;
  const top1 = results[0];
  if (!top1 || top1.score < WHISPER_MIN_SCORE) return false;
  return true;
}

export function formatWhisper(results: SearchResult[], query: string): string {
  if (results.length === 0) return "";
  const n = Math.min(results.length, 3);
  const headings = results.slice(0, n).map((r) => r.heading).join(", ");
  return `[memory hint: ${n} relevant entries (${headings}) — call memory_search("${query.slice(0, 40)}") for details]`;
}
