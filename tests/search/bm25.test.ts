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
});
