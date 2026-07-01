import { describe, it, expect } from "vitest";
import { consolidateMemory } from "../../src/extract/consolidate.js";

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
