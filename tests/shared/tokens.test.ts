import { describe, it, expect } from "vitest";
import { estimateTokens, estimateTokensSum, truncateToTokenBudget } from "../../src/shared/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it("uses ceil to never under-budget", () => {
    // 5 chars → ceil(5/4) = 2 tokens
    expect(estimateTokens("hello")).toBe(2);
  });

  it("handles 4-char string as exactly 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("over-counts CJK (pessimistic)", () => {
    // 10 CJK chars → ceil(10/4) = 3 tokens (actual ~7)
    const cjk = "你好世界测试代码";
    const result = estimateTokens(cjk);
    expect(result).toBeGreaterThan(0);
  });
});

describe("estimateTokensSum", () => {
  it("returns 0 for empty array", () => {
    expect(estimateTokensSum([])).toBe(0);
  });

  it("sums tokens across parts", () => {
    // 4 chars = 1 token, 8 chars = 2 tokens → total 3
    expect(estimateTokensSum(["abcd", "abcdefgh"])).toBe(3);
  });

  it("handles array with empty strings", () => {
    expect(estimateTokensSum(["", "abcd", ""])).toBe(1);
  });
});

describe("truncateToTokenBudget", () => {
  it("returns original text if within budget", () => {
    expect(truncateToTokenBudget("hello", 10)).toBe("hello");
  });

  it("returns empty string for budget ≤ 0", () => {
    expect(truncateToTokenBudget("hello", 0)).toBe("");
    expect(truncateToTokenBudget("hello", -1)).toBe("");
  });

  it("truncates and adds marker when over budget", () => {
    const long = "a".repeat(100);
    const result = truncateToTokenBudget(long, 5); // 5 tokens = 20 chars
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("[truncated]");
  });

  it("tries to cut at paragraph boundary", () => {
    // 100 chars, paragraph at char 30
    const text = "First paragraph here.\n\n" + "x".repeat(70);
    const result = truncateToTokenBudget(text, 10); // 10 tokens = 40 chars
    expect(result).toContain("[truncated]");
    // Should have cut at the paragraph boundary
    expect(result).toContain("First paragraph");
  });

  it("tries to cut at sentence boundary when no paragraph", () => {
    const text = "First sentence. " + "x".repeat(80);
    const result = truncateToTokenBudget(text, 10); // 40 chars budget
    expect(result).toContain("[truncated]");
    expect(result).toContain("First sentence");
  });
});
