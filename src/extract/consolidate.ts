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
  const newHash = simHash(newLine);
  const lines = existingContent.split("\n");
  for (const line of lines) {
    if (!line.startsWith("- [")) continue;
    const existingHash = simHash(line);
    const sim = similarity(newHash, existingHash);
    const threshold = newLine.length < 50 ? 0.98 : SIMILARITY_THRESHOLD;
    if (sim >= threshold) {
      return { existingLine: line, similarity: sim };
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

function simHash(s: string, bits = 64): number {
  const tokens = tokenize(s);
  if (tokens.length === 0) return 0;
  const v = new Int8Array(bits);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) - h + token.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < bits; i++) {
      if ((h >> i) & 1) v[i]++; else v[i]--;
    }
  }
  let hash = 0;
  for (let i = 0; i < bits; i++) {
    if (v[i] > 0) hash |= (1 << i);
  }
  return hash;
}

function hammingDistance(a: number, b: number): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor) { dist += xor & 1; xor >>>= 1; }
  return dist;
}

function similarity(a: number, b: number, bits = 64): number {
  return 1 - hammingDistance(a, b) / bits;
}

const SIMILARITY_THRESHOLD = 0.92;
const STALE_BINDING_RE = /^(- \[[^\]]+\] )(src\/[^\s:]+:[^\s:]+)(?::[a-f0-9]+)?\s/;

export function consolidateMemory(content: string, opts: ConsolidateOpts = {}): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const staleSet = new Set(opts.staleFilePaths ?? []);
  const seen: { hash: number; line: string }[] = [];
  const result: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("- [")) {
      result.push(line);
      continue;
    }

    if (staleSet.size > 0) {
      const m = line.match(STALE_BINDING_RE);
      if (m && staleSet.has(m[2])) continue;
    }

    const hash = simHash(line);
    const isDup = seen.some((s) => similarity(hash, s.hash) >= SIMILARITY_THRESHOLD);
    if (isDup) continue;

    seen.push({ hash, line });
    result.push(line);
  }

  return result.join("\n");
}
