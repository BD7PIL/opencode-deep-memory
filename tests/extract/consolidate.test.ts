import { describe, it, expect } from "vitest";
import { consolidateMemory, validateConsolidation } from "../../src/extract/consolidate.js";

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
});
