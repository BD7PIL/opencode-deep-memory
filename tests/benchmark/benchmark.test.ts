import { describe, it, expect } from "vitest";
import { BM25Index } from "../../src/search/bm25.js";
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
