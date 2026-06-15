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
});
