import { describe, it, expect } from "vitest";
import { tokenize, tokenizeQuery } from "../../src/search/tokenizer.js";

describe("tokenize", () => {
  it("handles CJK pure text with unigrams and bigrams", () => {
    const result = tokenize("权限死锁");
    expect(result).toContain("权");
    expect(result).toContain("权限");
    expect(result).toContain("限");
    expect(result).toContain("限死");
    expect(result).toContain("死");
    expect(result).toContain("死锁");
    expect(result).toContain("锁");
    expect(result).toHaveLength(7);
  });

  it("handles Latin pure text", () => {
    const result = tokenize("caused by mutex");
    expect(result).toEqual(["caused", "by", "mutex"]);
  });

  it("handles mixed CJK and Latin per DESIGN example", () => {
    const result = tokenize("权限死锁 caused by mutex");
    // Unigrams first, then bigrams, then Latin tokens
    expect(result).toEqual(["权", "限", "死", "锁", "权限", "限死", "死锁", "caused", "by", "mutex"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(tokenize("   \n\t  ")).toEqual([]);
  });

  it("returns empty array for pure punctuation", () => {
    expect(tokenize("!!!???...---")).toEqual([]);
  });

  it("handles hiragana characters", () => {
    const result = tokenize("こんにちは");
    expect(result).toContain("こ");
    expect(result).toContain("こん");
    expect(result).toContain("ん");
    expect(result).toContain("んに");
    expect(result).toHaveLength(9);
  });

  it("handles katakana characters", () => {
    const result = tokenize("テスト");
    expect(result).toContain("テ");
    expect(result).toContain("テス");
    expect(result).toContain("ス");
    expect(result).toContain("スト");
    expect(result).toContain("ト");
    expect(result).toHaveLength(5);
  });

  it("lowercases Latin text", () => {
    const result = tokenize("Hello WORLD");
    expect(result).toEqual(["hello", "world"]);
  });

  it("splits on punctuation", () => {
    const result = tokenize("foo,bar;baz.qux");
    expect(result).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("handles single CJK character", () => {
    const result = tokenize("权");
    expect(result).toEqual(["权"]);
  });

  it("handles two CJK characters", () => {
    const result = tokenize("权限");
    expect(result).toEqual(["权", "限", "权限"]);
  });

  it("handles mixed with punctuation between CJK and Latin", () => {
    const result = tokenize("权限: mutex");
    expect(result).toContain("权");
    expect(result).toContain("权限");
    expect(result).toContain("限");
    expect(result).toContain("mutex");
  });
});

describe("tokenizeQuery", () => {
  it("splits on pipe for OR semantics", () => {
    const result = tokenizeQuery("权限 | mutex");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(["权", "限", "权限"]);
    expect(result[1]).toEqual(["mutex"]);
  });

  it("handles single phrase (no pipe)", () => {
    const result = tokenizeQuery("deadlock");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["deadlock"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeQuery("")).toEqual([]);
  });

  it("filters empty phrases from pipe splits", () => {
    const result = tokenizeQuery("| | mutex");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["mutex"]);
  });
});
