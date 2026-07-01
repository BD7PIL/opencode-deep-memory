import { describe, it, expect } from "vitest";
import { ccrInjectMarker, ccrStore, ccrRetrieve } from "../../src/compress/ccr.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("ccrInjectMarker (V4 actionable hint)", () => {
  it("includes deep_expand recovery instruction in marker", () => {
    const hash = "abc123def456";
    const compressed = "head...tail";
    const result = ccrInjectMarker(compressed, hash);
    // V4: marker must tell the LLM how to recover the original
    expect(result).toContain("deep_expand");
    expect(result).toContain(hash);
    expect(result).toContain(compressed);
  });

  it("marker is actionable, not a dead-end", () => {
    const result = ccrInjectMarker("snippet", "h1");
    // Must NOT be the old dead-end format
    expect(result).not.toMatch(/^\S+\n\[ccr:h1\]$/);
    // Must contain a verb (call/use) instructing recovery
    expect(result).toMatch(/\b(call|use|invoke)\b/i);
  });
});

describe("ccrStore + ccrRetrieve round-trip", () => {
  it("stores original and retrieves it", () => {
    const state = createPluginState();
    const original = "line1\nline2\nline3".repeat(50);
    const compressed = "line1...line3";
    const hash = ccrStore(state, original, compressed);
    expect(ccrRetrieve(state, hash)).toBe(original);
  });
});
