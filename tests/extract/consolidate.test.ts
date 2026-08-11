import { describe, it, expect, beforeEach } from "vitest";
import { consolidateMemory, validateConsolidation, buildConsolidationPrompt, findNearDuplicate } from "../../src/extract/consolidate.js";

describe("consolidateMemory (Layer 5 synchronous)", () => {
  it("removes exact duplicate entries", () => {
    const content = [
      "## Decisions",
      "- [decision] Use vitest for testing.",
      "- [decision] Use vitest for testing.",
      "- [decision] Use TypeScript.",
    ].join("\n");
    const result = consolidateMemory(content);
    const matches = result.match(/Use vitest for testing/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain("Use TypeScript");
  });

  it("removes near-duplicate entries (very high similarity)", () => {
    const content = [
      "- [decision] Use vitest for testing the project always everywhere.",
      "- [decision] Use vitest for testing the project always everywhere now.",
      "- [constraint] Never use any in TypeScript code.",
    ].join("\n");
    const result = consolidateMemory(content);
    const vitestMentions = result.match(/Use vitest for testing the project always everywhere/g);
    expect(vitestMentions).toHaveLength(1);
    expect(result).toContain("Never use any");
  });

  it("preserves distinct entries", () => {
    const content = [
      "- [decision] Use vitest for testing.",
      "- [constraint] Never use any in TypeScript.",
      "- [gotcha] npm install fails on RHEL7 — use yarn.",
    ].join("\n");
    const result = consolidateMemory(content);
    expect(result).toContain("Use vitest");
    expect(result).toContain("Never use any");
    expect(result).toContain("npm install fails");
  });

  it("removes stale entries (file:symbol:hash mismatch)", () => {
    const content = [
      "- [constraint] src/old.ts:foo:abc123 must be pure",
      "- [decision] valid entry without binding",
    ].join("\n");
    const result = consolidateMemory(content, { staleFilePaths: ["src/old.ts:foo"] });
    expect(result).not.toContain("src/old.ts:foo");
    expect(result).toContain("valid entry without binding");
  });

  it("handles empty content", () => {
    expect(consolidateMemory("")).toBe("");
  });

  it("returns content unchanged when no duplicates or stale entries", () => {
    const content = "- [decision] Use X.\n- [constraint] Always Y.";
    expect(consolidateMemory(content)).toBe(content);
  });
});

describe("validateConsolidation (DCP #573 guard)", () => {
  it("accepts a valid shrink (shorter result)", () => {
    const original = "## Decisions\n- [decision] A\n- [decision] B\n- [decision] C\n";
    const result = "## Decisions\n- [decision] A+B merged\n- [decision] C\n";
    const v = validateConsolidation(original, result, { lines: 4 });
    expect(v.ok).toBe(true);
  });

  it("rejects output that grew beyond 1.05x original", () => {
    const original = "short";
    const result = "much much much longer output that exceeds the threshold";
    const v = validateConsolidation(original, result, { lines: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("grew");
  });
  it("rejects empty output", () => {
    const original = "## Decisions\n- [decision] A\n";
    const v = validateConsolidation(original, "", { lines: 2 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("empty");
  });

  it("rejects output exceeding 200-line cap", () => {
    // Original: 150 long entries (each ~50 chars = 7500 bytes)
    const original = Array.from({ length: 150 }, (_, i) => `- [decision] Some long detailed entry ${i} padding padding padding`).join("\n");
    // Result: 201 short entries (each ~15 chars = 3015 bytes < 7500*1.05)
    const result = Array.from({ length: 201 }, (_, i) => `Entry ${i}`).join("\n");
    const v = validateConsolidation(original, result, { lines: 150 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("200");
  });

  it("rejects over-deletion (<30% of original survived)", () => {
    // 50-line original, result only 10 lines = 20% < 30%
    const original = Array.from({ length: 50 }, (_, i) => `- [fact] fact ${i}`).join("\n");
    const result = Array.from({ length: 10 }, (_, i) => `- [fact] fact ${i}`).join("\n");
    const v = validateConsolidation(original, result, { lines: 50 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("over-deleted");
  });

  it("does NOT apply over-deletion guard for small originals (<20 lines)", () => {
    // 10-line original, result only 2 lines = 20% — but guard skips small originals
    const original = Array.from({ length: 10 }, (_, i) => `- [fact] fact ${i}`).join("\n");
    const result = "- [fact] fact 0\n- [fact] fact 1\n";
    const v = validateConsolidation(original, result, { lines: 10 });
    expect(v.ok).toBe(true);
  });
// ============================================================
// EDGE CASES: exact boundary values for validation thresholds
// ============================================================

  it("accepts result at exactly 1.05x ratio (boundary)", () => {
    // 1000 chars original, 1050 result = exactly 1.05 — should pass
    const original = "x".repeat(1000);
    const result = "x".repeat(1050);
    const v = validateConsolidation(original, result, { lines: 10 });
    expect(v.ok).toBe(true);
  });

  it("rejects result at 1.051x ratio (just over boundary)", () => {
    const original = "x".repeat(100000);
    const result = "x".repeat(105100); // 1.051x
    const v = validateConsolidation(original, result, { lines: 10 });
    expect(v.ok).toBe(false);
  });

  it("accepts result at exactly 200 lines (boundary)", () => {
    const original = Array.from({ length: 200 }, () => "- [fact] " + "x".repeat(50)).join("\n");
    const result = Array.from({ length: 200 }, (_, i) => `f${i}`).join("\n");
    const v = validateConsolidation(original, result, { lines: 200 });
    expect(v.ok).toBe(true);
  });

  it("rejects result at exactly 201 lines (just over boundary)", () => {
    const original = Array.from({ length: 200 }, () => "- [fact] " + "x".repeat(50)).join("\n");
    const result = Array.from({ length: 201 }, (_, i) => `f${i}`).join("\n");
    const v = validateConsolidation(original, result, { lines: 200 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("200");
  });

  it("accepts result at exactly 30% line retention (boundary)", () => {
    // 50-line original, result 15 lines = exactly 30% — should pass
    const original = Array.from({ length: 50 }, (_, i) => `- [fact] fact ${i} ${"x".repeat(40)}`).join("\n");
    const result = Array.from({ length: 15 }, (_, i) => `- [fact] fact ${i} shorter`).join("\n");
    const v = validateConsolidation(original, result, { lines: 50 });
    expect(v.ok).toBe(true);
  });

  it("rejects result at 29% line retention (just under boundary)", () => {
    // 50-line original, result 14 lines = 28% < 30% — should fail
    const original = Array.from({ length: 50 }, (_, i) => `- [fact] fact ${i} ${"x".repeat(40)}`).join("\n");
    const result = Array.from({ length: 14 }, (_, i) => `- [fact] fact ${i} shorter`).join("\n");
    const v = validateConsolidation(original, result, { lines: 50 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("over-deleted");
  });

  it("accepts whitespace-only output as non-empty (has content)", () => {
    // Note: whitespace-only is trim()-ed to empty string, should reject
    const original = "- [fact] real content";
    const v = validateConsolidation(original, "   \n\t  ", { lines: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("empty");
  });

  it("accepts equal-length result (no shrinkage, no growth)", () => {
    const original = "Hello World";
    const result = "Hello World";
    const v = validateConsolidation(original, result, { lines: 1 });
    expect(v.ok).toBe(true);
  });

// ============================================================
// PROMPT CONTENT: structural assertions on the generated prompt
// ============================================================

// ============================================================
// PROMPT CONTENT: structural assertions on the generated prompt
// ============================================================
});

describe("buildConsolidationPrompt (v0.11.4 community-sourced rules)", () => {
  const sampleContent = "## Decisions\n- [decision] Test\n";
  const stats = { lines: 2, bytes: 100 };
  let prompt: string;

  beforeEach(() => {
    prompt = buildConsolidationPrompt(sampleContent, stats);
  });

  it("includes ACTIONABLE rule (Claude-Code-Workflow)", () => {
    expect(prompt).toContain("ACTIONABLE");
  });

  it("includes NO PLATITUDES rule (Claude-Code-Workflow)", () => {
    expect(prompt).toContain("NO PLATITUDES");
  });

  it("includes SHRINK rule with target line count (DCP #573)", () => {
    expect(prompt).toContain("SHRINK");
    // target should be 80% of input lines
    const expectedTarget = Math.round(stats.lines * 0.8);
    expect(prompt).toContain(String(expectedTarget));
  });

  it("includes NEVER ADD rule (Mem0 'editor not writer')", () => {
    expect(prompt).toContain("NEVER ADD");
    expect(prompt).toContain("editor");
  });

  it("includes WHEN UNCERTAIN KEEP rule (balance against over-pruning)", () => {
    expect(prompt).toContain("WHEN UNCERTAIN");
    expect(prompt).toContain("KEEP");
  });

  it("includes CoT-then-strip PROCESS section (Claude Code)", () => {
    expect(prompt).toContain("PROCESS");
    expect(prompt).toContain("silently");
  });

  it("includes contradiction resolution guidance (claudeclaw)", () => {
    expect(prompt).toContain("YYYY-MM-DD");
    expect(prompt).toContain("authoritative");
  });

  it("includes no-op tolerance (OpenViking)", () => {
    expect(prompt).toContain("UNCHANGED");
  });

  it("includes the input content and stats", () => {
    expect(prompt).toContain(sampleContent);
    expect(prompt).toContain(String(stats.lines));
    expect(prompt).toContain(String(stats.bytes));
  });

  it("adapts target line count based on input size", () => {
    const small = buildConsolidationPrompt("short", { lines: 10, bytes: 50 });
    const large = buildConsolidationPrompt("x".repeat(1000), { lines: 100, bytes: 1000 });
    expect(small).toContain("8");   // 10 * 0.8 = 8
    expect(large).toContain("80"); // 100 * 0.8 = 80
  });
});

// ============================================================
// findNearDuplicate: A-Mem G8 write-time dedup helper
// ============================================================

describe("findNearDuplicate (A-Mem G8 write-time dedup)", () => {
  it("detects exact duplicate", () => {
    const existing = "## Decisions\n- [decision] Use vitest for testing. [2026-08-12]\n";
    const newLine = "- [decision] Use vitest for testing. [2026-08-12]";
    const dup = findNearDuplicate(newLine, existing);
    expect(dup).not.toBeNull();
    expect(dup!.similarity).toBeGreaterThan(0.9);
  });

  it("detects near-duplicate (high similarity)", () => {
    const existing = "- [decision] Use vitest for testing the project always everywhere. [2026-08-12]";
    const newLine = "- [decision] Use vitest for testing the project always everywhere now. [2026-08-12]";
    const dup = findNearDuplicate(newLine, existing);
    expect(dup).not.toBeNull();
  });

  it("returns null for completely different entries", () => {
    const existing = "- [decision] Use PostgreSQL for persistence. [2026-08-12]";
    const newLine = "- [gotcha] npm install fails on RHEL7. [2026-08-12]";
    const dup = findNearDuplicate(newLine, existing);
    expect(dup).toBeNull();
  });

  it("returns null for empty existing content", () => {
    const dup = findNearDuplicate("- [fact] new entry", "");
    expect(dup).toBeNull();
  });

  it("uses stricter threshold (0.98) for short lines to avoid false positives", () => {
    // Short entries with different subjects — SimHash should distinguish them
    // Only the decision type + date are shared; subjects are different words
    const existing = "- [decision] Deploy with Docker Compose [2026-08-12]";
       const newLine = "- [decision] Migrate from Jest to Vitest [2026-08-12]";
    const dup = findNearDuplicate(newLine, existing);
    expect(dup).toBeNull();
  });

  it("only compares lines starting with '- ['", () => {
    const existing = "## Decisions\nSome random text\n- [decision] real entry [2026-08-12]";
    const newLine = "- [decision] real entry [2026-08-12]";
    const dup = findNearDuplicate(newLine, existing);
    expect(dup).not.toBeNull();
    expect(dup!.existingLine).toContain("real entry");
  });
});
