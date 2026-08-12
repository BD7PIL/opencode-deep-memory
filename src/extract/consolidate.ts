/**
 * Layer 5: Synchronous consolidation. No background, no LLM.
 * SimHash dedup + stale-entry purge + LLM consolidation prompt. Runs in-hook.
 * See DESIGN_V4.md Layer 5.
 */

export function buildConsolidationPrompt(
  content: string,
  stats: { lines: number; bytes: number },
): string {
  const targetLines = Math.round(stats.lines * 0.8);
  return `You are a memory consolidation agent. Below is the current MEMORY.md
(${stats.lines} lines, ${stats.bytes} bytes).

## YOUR JOB
Produce a LEANER, SHARPER version. If the memory is already well-organized,
return it UNCHANGED.

## CRITICAL RULES

1. ACTIONABLE: Every surviving entry must name a specific future scenario
   where it prevents a mistake or speeds up a decision. If you can't, DELETE it.
2. NO PLATITUDES: Delete generic advice ("communicate clearly", "test
   thoroughly", "冥想 improves focus"). Keep only entries with specific
   technical details — file paths, function names, config values, errors.
3. MERGE: Combine entries about the same topic. Two entries about HiDPI
   scaling → one. Two about Python version limits → one.
4. DELETE STALE: Remove entries that are:
   - Superseded by a newer entry (compare [YYYY-MM-DD] date tags — the
     LATER date is authoritative).
   - Self-described as placeholder/dummy/sample/虚构/占位/example
   - About a resolved problem that will never recur
5. NEVER ADD: You are an editor, not a writer.
   Zero new facts. Zero new decisions. Zero hallucination.
6. SHRINK: Target ${targetLines} lines (70-90% of current). Under 200 hard cap.
   If already under 150 lines and well-organized, return unchanged.
7. WHEN UNCERTAIN between keeping and deleting, KEEP.
   False retention is cheap; false deletion is irreversible.
8. FORMAT: ## Heading + bullets. Sections: Decisions, Constraints, Gotchas,
   Facts. Move superseded entries to ## Archive with a note.

## PROCESS
Step 1: For each entry, silently decide KEEP / MERGE / DELETE.
Step 2: Output ONLY the consolidated MEMORY.md content. Do NOT output
        your reasoning or decisions list.

## TOPIC OFFLOAD
When an entry is too detailed (more than 3 lines), extract the detail to a
topic file (topics/<descriptive-name>.md) and replace the entry with:
  - [brief one-line summary] [topic:<descriptive-name>]
The agent can read full detail via memory_topic("<descriptive-name>", "read").

Current MEMORY.md:
---
${content}
---`;
}

/**
 * Validate LLM consolidation output before applying to MEMORY.md.
 * Prevents DCP #573 failure mode (738K tokens burned on unbounded summary growth).
 *
 * Checks:
 * 1. Non-empty output
 * 2. Output did not grow beyond 1.05x original (allows minor reformatting)
 * 3. Output does not exceed 200-line hard cap
 * 4. Output did not over-delete (<30% of original survived — suspicious for weak models)
 */
export function validateConsolidation(
  original: string,
  result: string,
  originalStats: { lines: number },
): { ok: true } | { ok: false; reason: string } {
  if (result.trim().length === 0)
    return { ok: false, reason: "empty output" };
  if (result.length > original.length * 1.05)
    return { ok: false, reason: `output grew: ${result.length} > ${original.length} * 1.05` };
  const resultLines = result.split("\n").length;
  if (resultLines > 200)
    return { ok: false, reason: `${resultLines} lines exceeds 200-line cap` };
  // Over-deletion guard: reject if <30% of original survived.
  // A valid consolidation shrinks to 70-90%; anything below 30% is suspicious.
  const minExpectedLines = Math.round(originalStats.lines * 0.3);
  if (originalStats.lines > 20 && resultLines < minExpectedLines)
    return { ok: false, reason: `over-deleted: ${resultLines} < ${minExpectedLines} (30% of ${originalStats.lines})` };
  return { ok: true };
}

/**
 * Find a near-duplicate entry in existing MEMORY.md content (A-Mem G8 pattern).
 * Compares the new line against every '- [' entry using SimHash similarity.
 * Short lines (<50 chars) use a stricter threshold (0.98) to avoid false positives.
 */
export function findNearDuplicate(
  newLine: string,
  existingContent: string,
): { existingLine: string; similarity: number } | null {
  const lines = existingContent.split("\n");
  for (const line of lines) {
    // Entry = any '- ' bullet line (matches real V5 format '- content'
    // and legacy '- [type] content'). The old '- [' filter missed real entries.
    if (!line.trim().startsWith("- ")) continue;

    // Exact-match short-circuit: identical normalized text is always a duplicate
    const normalizedNew = newLine.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, "").trim();
    const normalizedExisting = line.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, "").trim();
    if (normalizedNew === normalizedExisting) {
      return { existingLine: line, similarity: 1 };
    }

    // Token-set Jaccard matching: overlap of real content words.
    // NOTE: SimHash fuzzy matching was REMOVED — 64-bit SimHash has severe
    // false-positive issues on long text (completely different entries scored
    // 0.83-0.94 similarity in real E2E, crossing the 0.92 threshold).
    // Token Jaccard is the actual semantic overlap: different content gets
    // low scores, near-identical content gets high scores.
    const newTokens = new Set(tokenize(normalizedNew));
    const existingTokens = new Set(tokenize(normalizedExisting));
    if (newTokens.size > 0 && existingTokens.size > 0) {
      let intersect = 0;
      for (const t of newTokens) if (existingTokens.has(t)) intersect++;
      const union = newTokens.size + existingTokens.size - intersect;
      const jaccard = intersect / union;
      // High threshold: only flag near-duplicates (90%+ token overlap)
      if (jaccard >= 0.9) {
        return { existingLine: line, similarity: jaccard };
      }
    }
  }
  return null;
}

interface ConsolidateOpts {
  staleFilePaths?: string[];
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s\-,.\[\](){}:]+/).filter((w) => w.length > 2);
}

const STALE_BINDING_RE = /^(- \[[^\]]+\] )(src\/[^\s:]+:[^\s:]+)(?::[a-f0-9]+)?\s/;

export function consolidateMemory(content: string, opts: ConsolidateOpts = {}): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const staleSet = new Set(opts.staleFilePaths ?? []);
  const seen: { tokens: Set<string>; line: string }[] = [];
  const result: string[] = [];

  for (const line of lines) {
    // Entry = any '- ' bullet line. Real MEMORY.md entries are stored as
    // '- content' (V5 addEntry format) OR '- [type] content' (older format).
    // The old '- [' filter silently skipped real entries, breaking dedup.
    if (!line.trim().startsWith("- ")) {
      result.push(line);
      continue;
    }

    if (staleSet.size > 0) {
      const m = line.match(STALE_BINDING_RE);
      if (m && staleSet.has(m[2])) continue;
    }

    const lineTokens = new Set(tokenize(line.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, "")));
    // NOTE: SimHash fuzzy dedup removed — 64-bit SimHash false-positives on
    // long text (different entries scored 0.83-0.94 in real E2E).
    // Token Jaccard ≥ 0.9 = genuine near-duplicate.
    const isDup = seen.some((s) => {
      if (s.tokens.size === 0 || lineTokens.size === 0) return false;
      let intersect = 0;
      for (const t of lineTokens) if (s.tokens.has(t)) intersect++;
      const union = s.tokens.size + lineTokens.size - intersect;
      return intersect / union >= 0.9;
    });
    if (isDup) continue;

    seen.push({ tokens: lineTokens, line });
    result.push(line);
  }

  return result.join("\n");
}
