import { describe, it, expect } from "vitest";
import { dedupByJaccard } from "../../src/inject/dedup.js";

describe("dedupByJaccard", () => {
  it("returns empty array for empty input", () => {
    expect(dedupByJaccard([], (s) => s)).toEqual([]);
  });

  it("merges identical strings", () => {
    const items = ["hello world", "hello world"];
    expect(dedupByJaccard(items, (s) => s)).toEqual(["hello world"]);
  });

  it("merges strings with Jaccard > 0.85", () => {
    // "the cat sat on the mat" vs "the cat sat on the mat again"
    // tokens: {the,cat,sat,on,the,mat} vs {the,cat,sat,on,the,mat,again}
    // unique: {the,cat,sat,on,mat} vs {the,cat,sat,on,mat,again}
    // intersection=5, union=6, Jaccard=5/6≈0.833 — just under 0.85
    // Let's use something more overlapping:
    // "a b c d e f g h" vs "a b c d e f g h i"
    // unique: {a,b,c,d,e,f,g,h} vs {a,b,c,d,e,f,g,h,i}
    // intersection=8, union=9, Jaccard=8/9≈0.889 > 0.85 → merged
    const items = ["a b c d e f g h", "a b c d e f g h i"];
    const result = dedupByJaccard(items, (s) => s);
    expect(result).toEqual(["a b c d e f g h"]);
  });

  it("keeps strings with Jaccard <= 0.85", () => {
    // "hello world" vs "goodbye moon"
    // tokens: {hello,world} vs {goodbye,moon}
    // intersection=0, union=4, Jaccard=0 → kept
    const items = ["hello world", "goodbye moon"];
    const result = dedupByJaccard(items, (s) => s);
    expect(result).toEqual(["hello world", "goodbye moon"]);
  });

  it("keeps moderately similar strings (Jaccard < 0.85)", () => {
    // "the cat sat on the mat" vs "the dog sat on the log"
    // unique: {the,cat,sat,on,mat} vs {the,dog,sat,on,log}
    // intersection=3, union=7, Jaccard=3/7≈0.429 → kept
    const items = ["the cat sat on the mat", "the dog sat on the log"];
    const result = dedupByJaccard(items, (s) => s);
    expect(result).toHaveLength(2);
  });

  it("handles CJK tokens", () => {
    // "这是一段测试文本" vs "这是一段测试文本内容"
    // tokenize → ["这","是","一","段","测","试","文","本"] vs + ["内","容"]
    // unique 8 vs 10, intersection=8, union=10, Jaccard=0.8 < 0.85 → kept
    const items = ["这是一段测试文本", "这是一段测试文本内容"];
    const result = dedupByJaccard(items, (s) => s);
    expect(result).toHaveLength(2);
  });

  it("respects custom threshold parameter", () => {
    // At threshold 0.5, "hello world" vs "hello world test"
    // tokens: {hello,world} vs {hello,world,test}
    // intersection=2, union=3, Jaccard≈0.667
    const items = ["hello world", "hello world test"];
    // Default threshold 0.85 → keeps both
    expect(dedupByJaccard(items, (s) => s)).toHaveLength(2);
    // Threshold 0.5 → 0.667 > 0.5 → merges
    expect(dedupByJaccard(items, (s) => s, 0.5)).toHaveLength(1);
  });

  it("deduplicates multiple items greedily (first wins)", () => {
    // Three items where A≈B and A≈C but B≠C
    // "a b c d e f g h" vs "a b c d e f g h i" (Jaccard 8/9≈0.889)
    // "a b c d e f g h" vs "x y z a b c d e" (Jaccard 5/10=0.5)
    // "a b c d e f g h i" vs "x y z a b c d e" (Jaccard 5/11≈0.455)
    const items = ["a b c d e f g h", "a b c d e f g h i", "x y z a b c d e"];
    const result = dedupByJaccard(items, (s) => s);
    // First kept, second merged (similar to first), third kept (different)
    expect(result).toEqual(["a b c d e f g h", "x y z a b c d e"]);
  });

  it("works with object items via getText", () => {
    const items = [
      { id: 1, text: "alpha beta gamma" },
      { id: 2, text: "alpha beta gamma" },
      { id: 3, text: "delta epsilon" },
    ];
    const result = dedupByJaccard(items, (item) => item.text);
    expect(result).toEqual([
      { id: 1, text: "alpha beta gamma" },
      { id: 3, text: "delta epsilon" },
    ]);
  });

  it("single item always kept", () => {
    expect(dedupByJaccard(["only"], (s) => s)).toEqual(["only"]);
  });
});
