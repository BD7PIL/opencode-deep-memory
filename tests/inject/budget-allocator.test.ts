import { describe, it, expect } from "vitest";
import { allocateAndRender } from "../../src/inject/budget-allocator.js";
import type { SearchResultLike } from "../../src/inject/budget-allocator.js";

function makeResult(score: number, heading: string, snippet: string, scope = "project"): SearchResultLike {
  return { score, heading, snippet, scope };
}

describe("allocateAndRender", () => {
  it("returns empty array for empty results", () => {
    expect(allocateAndRender([], { budget: 500 })).toEqual([]);
  });

  it("allocates P1 for single high-importance result with sufficient budget", () => {
    // constraint(80) + recency(10) + bm25 top20(+30) = 120, clamped to 100
    const results = [makeResult(10, "constraint rule", "Must use strict mode.")];
    const allocated = allocateAndRender(results, {
      budget: 500,
      ageDays: () => 3,
    });
    expect(allocated).toHaveLength(1);
    expect(allocated[0].tier).toBe(1);
    expect(allocated[0].rendered).toContain("Must use strict mode.");
  });

  it("downgrades tier when budget is insufficient for P1", () => {
    // High importance but tiny budget forces downgrade
    const results = [makeResult(10, "constraint rule", "x".repeat(1000))];
    const allocated = allocateAndRender(results, {
      budget: 70, // enough for P2 (>60) but not P1 (250 tokens needed)
      ageDays: () => 3,
    });
    expect(allocated).toHaveLength(1);
    // Should get P2 since remaining > 60
    expect(allocated[0].tier).toBe(2);
  });

  it("handles budget exhaustion with tier downgrade across multiple entries", () => {
    const results = [
      makeResult(10, "constraint A", "First constraint about something."),
      makeResult(9, "constraint B", "Second constraint about something else."),
      makeResult(8, "constraint C", "Third constraint about another thing."),
    ];
    // Budget only allows a couple entries
    const allocated = allocateAndRender(results, {
      budget: 100,
      ageDays: () => 3,
    });
    expect(allocated.length).toBeGreaterThanOrEqual(2);
    // Total tokens should not exceed budget
    const totalTokens = allocated.reduce((sum, e) => sum + e.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(100);
  });

  it("computes BM25 percentile boost correctly", () => {
    // 5 results with scores 100, 80, 60, 40, 20
    // top20 threshold = sortedScores[floor(5*0.2)] = sortedScores[1] = 80
    // top50 threshold = sortedScores[floor(5*0.5)] = sortedScores[2] = 60
    const results = [
      makeResult(100, "item A", "Content A"), // score >= top20(80) → +30
      makeResult(80, "item B", "Content B"),  // score >= top20(80) → +30
      makeResult(60, "item C", "Content C"),  // score >= top50(60) → +15
      makeResult(40, "item D", "Content D"),  // below top50 → +0
      makeResult(20, "item E", "Content E"),  // below top50 → +0
    ];

    const allocated = allocateAndRender(results, {
      budget: 10000,
      ageDays: () => 60, // no recency bonus
    });

    // Items with higher BM25 boost should appear first (sorted by fused importance)
    // item A/B: note(30) + 30 = 60
    // item C: note(30) + 15 = 45
    // item D/E: note(30) + 0 = 30
    expect(allocated[0].heading).toMatch(/item [AB]/);
    expect(allocated[1].heading).toMatch(/item [AB]/);
    expect(allocated[2].heading).toBe("item C");
  });

  it("does not overshoot budget (exact budget fit)", () => {
    const results = [
      makeResult(10, "rule one", "Short."),
      makeResult(9, "rule two", "Also short."),
      makeResult(8, "rule three", "Another short one."),
    ];
    const budget = 60;
    const allocated = allocateAndRender(results, {
      budget,
      ageDays: () => 60,
    });
    const totalTokens = allocated.reduce((sum, e) => sum + e.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(budget);
  });

  it("infers type from heading keywords", () => {
    const results = [
      makeResult(5, "Important constraint for the system", "x"),
      makeResult(5, "Design decision recorded", "x"),
      makeResult(5, "Gotcha with the API", "x"),
      makeResult(5, "Interesting fact about the codebase", "x"),
      makeResult(5, "Random note", "x"),
    ];
    const allocated = allocateAndRender(results, {
      budget: 10000,
      ageDays: () => 60,
    });

    const byHeading = new Map(allocated.map((e) => [e.heading, e.type]));
    expect(byHeading.get("Important constraint for the system")).toBe("constraint");
    expect(byHeading.get("Design decision recorded")).toBe("decision");
    expect(byHeading.get("Gotcha with the API")).toBe("gotcha");
    expect(byHeading.get("Interesting fact about the codebase")).toBe("fact");
    expect(byHeading.get("Random note")).toBe("note");
  });

  it("uses typeOf override when provided", () => {
    const results = [makeResult(5, "Some heading", "Content here.")];
    const allocated = allocateAndRender(results, {
      budget: 500,
      ageDays: () => 60,
      typeOf: () => "custom-type",
    });
    expect(allocated[0].type).toBe("custom-type");
  });

  it("allocates P4 when remaining budget is very small", () => {
    // Consume most budget, then check that last item gets P4 or breaks
    const longSnippet = "x".repeat(800); // 200 tokens for P1
    const results = [
      makeResult(10, "constraint A", longSnippet),
      makeResult(5, "note B", "Small content."),
    ];
    const allocated = allocateAndRender(results, {
      budget: 250, // first item consumes ~200+ tokens at P1
      ageDays: () => 3,
    });
    // After first P1 allocation, remaining should be small
    expect(allocated.length).toBeGreaterThanOrEqual(1);
    if (allocated.length === 2) {
      expect([3, 4]).toContain(allocated[1].tier);
    }
  });

  it("STRESS: 50+ results with varying relevance → at least 2 distinct tiers used", () => {
    const results: SearchResultLike[] = [];
    for (let i = 0; i < 60; i++) {
      const score = Math.exp(-i / 10) * 15 + Math.random() * 2;
      const heading = i < 10 ? "constraint rule" : i < 25 ? "decision" : i < 40 ? "fact" : "note";
      const snippet = `Entry ${i}: `.padEnd(50 + (i % 3) * 30, "x") + ` content about topic ${i % 5}`;
      results.push(makeResult(score, heading, snippet));
    }

    // Two-phase: 250 budget allows 16 at P4 (240) + 1 upgrade to P3 (10)
    const allocated = allocateAndRender(results, { budget: 250 });

    expect(allocated.length).toBeGreaterThan(1);
    const tiers = [...new Set(allocated.map((a) => a.tier))];
    expect(tiers.length).toBeGreaterThanOrEqual(2);

    const totalTokens = allocated.reduce((s, a) => s + a.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(265);
  });

  it("STRESS: tight budget forces tier downgrade for most entries", () => {
    const results: SearchResultLike[] = Array.from({ length: 40 }, (_, i) =>
      makeResult(10 - i * 0.2, i < 15 ? "constraint" : "note", `long content ${i}: `.padEnd(80, "."))
    );

    const allocated = allocateAndRender(results, { budget: 55 });

    expect(allocated.length).toBeGreaterThan(0);
    const totalTokens = allocated.reduce((s, a) => s + a.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(65);

    const highTiers = allocated.filter((a) => a.tier <= 2).length;
    expect(highTiers).toBeLessThanOrEqual(2);
  });

  it("STRESS: large budget shows most entries at high tier", () => {
    const results: SearchResultLike[] = Array.from({ length: 20 }, (_, i) =>
      makeResult(12 - i * 0.3, i < 10 ? "constraint" : "decision", `content ${i}`)
    );

    const allocated = allocateAndRender(results, { budget: 3000 });

    expect(allocated.length).toBe(20);
    const tier1Count = allocated.filter((a) => a.tier === 1).length;
    expect(tier1Count).toBeGreaterThanOrEqual(10);
  });

  it("O21: two-phase shows more entries than budget/200 (greedy P1 would)", () => {
    const results: SearchResultLike[] = Array.from({ length: 200 }, (_, i) =>
      makeResult(10, "note", `Entry ${i}: some content here`)
    );
    // With 200t budget, two-phase should show 13 entries (200/15=floor(13.3))
    const allocated = allocateAndRender(results, { budget: 200 });
    expect(allocated.length).toBeGreaterThanOrEqual(13);
    expect(allocated.length).toBeLessThanOrEqual(13);
    // All at P4 since no upgrade budget
    expect(allocated.every((a) => a.tier === 4)).toBe(true);
  });

  it("O21: two-phase upgrades highest-importance entries first", () => {
    const results: SearchResultLike[] = [
      makeResult(10, "constraint rule", "Important constraint."),  // high importance
      makeResult(5, "note", "Just a note."),                       // low importance
      makeResult(5, "note", "Another note."),                      // low importance
    ];
    // 100t budget: 6 at P4 = 90, remaining 10 → one upgrade P4→P3
    const allocated = allocateAndRender(results, { budget: 100 });
    expect(allocated.length).toBeGreaterThanOrEqual(3);
    // First entry (highest importance) should be upgraded
    expect(allocated[0].tier).toBeLessThan(allocated[allocated.length - 1].tier);
  });

  it("O21: two-phase respects exact budget boundary", () => {
    const results: SearchResultLike[] = Array.from({ length: 10 }, (_, i) =>
      makeResult(10, "constraint rule", `Content ${i}`)
    );
    // 150 budget exactly: 10 entries × 15 = 150, 0 remaining
    const allocated = allocateAndRender(results, { budget: 150 });
    expect(allocated.length).toBe(10);
    const totalTokens = allocated.reduce((s, a) => s + a.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(150);
  });
});
