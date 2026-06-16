import { describe, it, expect } from "vitest";
import { BM25Index } from "../../src/search/bm25.js";
import { allocateAndRender } from "../../src/inject/budget-allocator.js";
import { dedupByJaccard } from "../../src/inject/dedup.js";
import { tokenize } from "../../src/search/tokenizer.js";

describe("BENCHMARK: BM25 Scale", () => {
  for (const n of [100, 500, 1000, 2000, 5000]) {
    it(`${n} docs: rebuild + search p99`, () => {
      const idx = new BM25Index();
      const docs = Array.from({ length: n }, (_, i) => ({
        id: `d${i}`,
        tokens: [...tokenize(`Document ${i} about topic ${i % 50} with keyword test and data${i}`)],
      }));

      const t0 = process.hrtime.bigint();
      for (const d of docs) idx.addDocument(d.id, d.tokens);
      const rebuildMs = Number(process.hrtime.bigint() - t0) / 1e6;

      const latencies: number[] = [];
      for (let j = 0; j < 100; j++) {
        const t1 = process.hrtime.bigint();
        idx.search(["topic", "test", `data${j % n}`]);
        latencies.push(Number(process.hrtime.bigint() - t1) / 1e6);
      }
      latencies.sort((a, b) => a - b);
      const p50 = latencies[50].toFixed(2);
      const p99 = latencies[99].toFixed(2);

      console.log(`  ${n} docs: rebuild=${rebuildMs.toFixed(1)}ms search p50=${p50}ms p99=${p99}ms`);
      expect(idx.size).toBe(n);
      expect(rebuildMs).toBeLessThan(5000);
      expect(parseFloat(p99)).toBeLessThan(250);
    });
  }
});

describe("BENCHMARK: Tier Allocator Scale", () => {
  for (const n of [10, 50, 100, 200]) {
    it(`${n} entries × 3 budgets`, () => {
      const results = Array.from({ length: n }, (_, i) => ({
        score: Math.max(0.1, 15 - i * (15 / n)),
        heading: i < n * 0.2 ? "constraint" : i < n * 0.5 ? "decision" : "note",
        snippet: `Entry ${i}: `.padEnd(40 + (i % 4) * 20, "x") + ` topic ${i % 10}`,
        scope: "project",
      }));

      for (const budget of [200, 500, 1000]) {
        const t0 = process.hrtime.bigint();
        const alloc = allocateAndRender(results, { budget });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const tiers = [...new Set(alloc.map((a) => a.tier))];
        const tokens = alloc.reduce((s, a) => s + a.tokens, 0);

        console.log(`  ${n} entries, ${budget}t: ${ms.toFixed(2)}ms, ${alloc.length}/${n} shown, tiers=[${tiers}], tokens=${tokens}/${budget}`);
        expect(tokens).toBeLessThanOrEqual(budget + 50);
        expect(alloc.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("BENCHMARK: Dedup Scale", () => {
  for (const n of [10, 50, 100, 500]) {
    it(`${n} items`, () => {
      const items = Array.from({ length: n }, (_, i) => `entry ${i} with content about topic ${i % 20}`);
      const t0 = process.hrtime.bigint();
      const deduped = dedupByJaccard(items, (s) => s);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`  ${n} items: ${ms.toFixed(2)}ms, kept=${deduped.length}, removed=${n - deduped.length}`);
      expect(deduped.length).toBeLessThanOrEqual(n);
    });
  }
});

describe("BENCHMARK: Tokenizer Scale", () => {
  for (const n of [1, 10, 50, 100]) {
    it(`${n}KB text`, () => {
      const cjk = "权限管理系统".repeat(n * 10);
      const mixed = cjk + " mixed with english words ".repeat(n * 10);
      const t0 = process.hrtime.bigint();
      const tokens = tokenize(mixed);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`  ${n}KB: ${ms.toFixed(2)}ms, ${tokens.length} tokens, ${(mixed.length / 1024).toFixed(0)}KB input`);
      expect(tokens.length).toBeGreaterThan(0);
    });
  }
});
