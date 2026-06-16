import { describe, it, expect } from "vitest";
import { renderTier } from "../../src/inject/tier-renderer.js";

describe("renderTier", () => {
  describe("P1 (full text)", () => {
    it("returns full text when content fits in 200 tokens", () => {
      const content = "Short content here.";
      const result = renderTier(content, "fact", "MyHeading", 1);
      expect(result).toBe("- [MyHeading] Short content here.");
    });

    it("truncates when content exceeds 200 tokens (800 chars)", () => {
      const content = "x".repeat(900); // 900 chars → 225 tokens > 200
      const result = renderTier(content, "fact", "MyHeading", 1);
      expect(result).toContain("... [truncated]");
      expect(result).toMatch(/^- \[MyHeading\] x{800}\.\.\. \[truncated\]$/);
    });
  });

  describe("P2 (first sentence + type)", () => {
    it("extracts first sentence on period", () => {
      const content = "First sentence. Second sentence.";
      const result = renderTier(content, "decision", "H", 2);
      expect(result).toBe("- [decision] First sentence");
    });

    it("extracts first sentence on Chinese period", () => {
      const content = "这是第一句。这是第二句。";
      const result = renderTier(content, "fact", "H", 2);
      expect(result).toBe("- [fact] 这是第一句");
    });

    it("truncates to 200 chars", () => {
      const longSentence = "a".repeat(300);
      const result = renderTier(longSentence, "note", "H", 2);
      expect(result.length).toBeLessThanOrEqual("- [note] ".length + 200);
    });

    it("handles content ending with newline", () => {
      const content = "First line\nSecond line";
      const result = renderTier(content, "gotcha", "H", 2);
      expect(result).toBe("- [gotcha] First line");
    });
  });

  describe("P3 (first 10 words + type)", () => {
    it("returns first 10 words", () => {
      const content = "one two three four five six seven eight nine ten eleven twelve";
      const result = renderTier(content, "fact", "H", 3);
      expect(result).toBe("- [fact] one two three four five six seven eight nine ten");
    });

    it("truncates to 80 chars", () => {
      const content = "w".repeat(100);
      const result = renderTier(content, "note", "H", 3);
      expect(result.length).toBeLessThanOrEqual("- [note] ".length + 80);
    });
  });

  describe("P4 (type label only)", () => {
    it("returns just the type label", () => {
      expect(renderTier("anything", "constraint", "H", 4)).toBe("- [constraint]");
    });
  });

  describe("P5 (empty)", () => {
    it("returns empty string", () => {
      expect(renderTier("anything", "fact", "H", 5)).toBe("");
    });
  });

  describe("CJK sentence splitting", () => {
    it("splits on Chinese exclamation mark", () => {
      const content = "重要！这是后续内容";
      const result = renderTier(content, "constraint", "H", 2);
      expect(result).toBe("- [constraint] 重要");
    });

    it("splits on Chinese question mark", () => {
      const content = "这是问题？这是回答";
      const result = renderTier(content, "gotcha", "H", 2);
      expect(result).toBe("- [gotcha] 这是问题");
    });
  });
});
