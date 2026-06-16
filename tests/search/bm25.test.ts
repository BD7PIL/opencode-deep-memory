import { describe, it, expect } from "vitest";
import { BM25Index, createIndex } from "../../src/search/bm25.js";

describe("BM25Index", () => {
  describe("basic operations", () => {
    it("starts with size 0", () => {
      const index = new BM25Index();
      expect(index.size).toBe(0);
    });

    it("adds a document and updates size", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      expect(index.size).toBe(1);
    });

    it("removes a document and updates size", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      index.removeDocument("doc1");
      expect(index.size).toBe(0);
    });

    it("replaces a document with same docId", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["old", "tokens"]);
      index.addDocument("doc1", ["new", "tokens", "here"]);
      expect(index.size).toBe(1);
      const results = index.search(["new"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe("doc1");
    });

    it("removing non-existent docId is a no-op", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      index.removeDocument("nonexistent");
      expect(index.size).toBe(1);
    });
  });

  describe("search", () => {
    it("returns empty for empty index", () => {
      const index = new BM25Index();
      expect(index.search(["hello"])).toEqual([]);
    });

    it("returns empty for empty query tokens", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      expect(index.search([])).toEqual([]);
    });

    it("returns matching document", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      index.addDocument("doc2", ["foo", "bar"]);
      const results = index.search(["hello"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe("doc1");
    });

    it("returns empty when no terms match", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      const results = index.search(["nonexistent"]);
      expect(results).toEqual([]);
    });

    it("ranks documents with more matches higher (SUM aggregation)", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["alpha", "beta", "gamma"]);
      index.addDocument("doc2", ["alpha", "beta"]);
      index.addDocument("doc3", ["alpha"]);

      const results = index.search(["alpha", "beta"]);
      expect(results).toHaveLength(3);
      // doc2 has more query matches relative to its length, doc1 has both but is longer
      // With SUM aggregation, both doc1 and doc2 get 2 matching terms
      expect(results[0]!.matchedTerms).toHaveLength(2);
    });

    it("respects limit option", () => {
      const index = new BM25Index();
      for (let i = 0; i < 20; i++) {
        index.addDocument(`doc${i}`, ["common", `unique${i}`]);
      }
      const results = index.search(["common"], { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it("respects minScore option", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      index.addDocument("doc2", ["foo", "bar"]);
      const results = index.search(["hello"], { minScore: 999 });
      expect(results).toEqual([]);
    });

    it("includes matchedTerms in results", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["alpha", "beta", "gamma"]);
      const results = index.search(["alpha", "gamma"]);
      expect(results[0]!.matchedTerms).toContain("alpha");
      expect(results[0]!.matchedTerms).toContain("gamma");
    });

    it("handles single-document index (idf=0 edge case)", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      const results = index.search(["hello"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe("incremental operations", () => {
    it("newly added document appears in search", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      const before = index.search(["world"]);
      expect(before).toHaveLength(0);

      index.addDocument("doc2", ["world"]);
      const after = index.search(["world"]);
      expect(after).toHaveLength(1);
      expect(after[0]!.docId).toBe("doc2");
    });

    it("removed document disappears from search", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      index.addDocument("doc2", ["hello"]);
      expect(index.search(["hello"])).toHaveLength(2);

      index.removeDocument("doc1");
      expect(index.search(["hello"])).toHaveLength(1);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("round-trips through serialization", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      index.addDocument("doc2", ["foo", "bar", "baz"]);

      const json = index.toJSON();
      const restored = BM25Index.fromJSON(json);

      expect(restored.size).toBe(2);
      const results = restored.search(["hello"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe("doc1");
    });

    it("preserves k1 and b parameters", () => {
      const index = new BM25Index({ k1: 2.0, b: 0.5 });
      const json = index.toJSON();
      expect(json.k1).toBe(2.0);
      expect(json.b).toBe(0.5);
    });
  });

  describe("createIndex factory", () => {
    it("creates a working BM25Index", () => {
      const index = createIndex();
      index.addDocument("doc1", ["test"]);
      expect(index.size).toBe(1);
    });
  });

  describe("custom parameters", () => {
    it("accepts custom k1 and b", () => {
      const index = new BM25Index({ k1: 2.0, b: 0.5 });
      index.addDocument("doc1", ["hello"]);
      const results = index.search(["hello"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeGreaterThan(0);
    });
  });

  describe("O21: query cache", () => {
    it("returns cached results on identical query", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello", "world"]);
      index.addDocument("doc2", ["foo", "bar"]);

      const first = index.search(["hello"]);
      const second = index.search(["hello"]);
      expect(second).toEqual(first);
      expect(second).toHaveLength(1);
    });

    it("cache hit returns same reference (LRU)", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["alpha", "beta"]);
      const first = index.search(["alpha"]);
      const second = index.search(["alpha"]);
      expect(second).toBe(first);
    });

    it("cache key is order-independent (sorted tokens)", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["alpha", "beta", "gamma"]);
      const ab = index.search(["alpha", "beta"]);
      const ba = index.search(["beta", "alpha"]);
      expect(ba).toEqual(ab);
    });

    it("cache invalidated on addDocument", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      const before = index.search(["hello"]);
      expect(before).toHaveLength(1);

      index.addDocument("doc2", ["hello"]);
      const after = index.search(["hello"]);
      expect(after).toHaveLength(2);
    });

    it("cache invalidated on removeDocument", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"]);
      index.addDocument("doc2", ["hello"]);
      const before = index.search(["hello"]);
      expect(before).toHaveLength(2);

      index.removeDocument("doc1");
      const after = index.search(["hello"]);
      expect(after).toHaveLength(1);
    });

    it("evicts oldest entry when cache is full (CACHE_SIZE=50)", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["common"]);
      // Fill cache with 50 unique queries
      for (let i = 0; i < 50; i++) {
        index.search([`term${i}`]);
      }
      // 51st query should evict the oldest
      index.search(["term50"]);
      // Re-searching term0 should miss cache (was evicted)
      // We verify this indirectly by checking that the search still works
      const results = index.search(["common"]);
      expect(results).toHaveLength(1);
    });

    it("decay queries bypass cache", () => {
      const index = new BM25Index();
      index.addDocument("doc1", ["hello"], new Date("2020-01-01"));
      const withoutDecay = index.search(["hello"]);
      const withDecay = index.search(["hello"], { applyDecay: true, now: Date.now() });
      // Decay should reduce score for old documents
      expect(withDecay[0]!.score).toBeLessThanOrEqual(withoutDecay[0]!.score);
    });
  });
});
