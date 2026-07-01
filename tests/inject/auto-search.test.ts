import { describe, it, expect } from "vitest";
import { shouldWhisper, formatWhisper } from "../../src/inject/auto-search.js";
import type { SearchResult } from "../../src/search/service.js";

function makeResult(score: number, heading: string): SearchResult {
  return {
    scope: "project",
    heading,
    snippet: `details about ${heading}`,
    score,
    file: `${heading}.md`,
    line: 1,
    docId: heading,
    filePath: `${heading}.md`,
    matchedTerms: [],
  } as unknown as SearchResult;
}

describe("shouldWhisper (D2 thresholds)", () => {
  it("fires when top-1 score >= 2.0 AND in top-20 percentile", () => {
    const results = [
      makeResult(5.0, "high"),
      makeResult(0.5, "low"),
      makeResult(0.3, "noise"),
    ];
    expect(shouldWhisper(results)).toBe(true);
  });

  it("does NOT fire when top-1 score < 2.0 (absolute floor)", () => {
    const results = [
      makeResult(1.5, "medium"),
      makeResult(0.5, "low"),
    ];
    expect(shouldWhisper(results)).toBe(false);
  });

  it("does NOT fire when results is empty", () => {
    expect(shouldWhisper([])).toBe(false);
  });

  it("fires when single result with high score", () => {
    const results = [makeResult(3.0, "only")];
    expect(shouldWhisper(results)).toBe(true);
  });

  it("does NOT fire when all scores are noise (< 0.5)", () => {
    const results = [
      makeResult(0.3, "noise1"),
      makeResult(0.2, "noise2"),
    ];
    expect(shouldWhisper(results)).toBe(false);
  });
});

describe("formatWhisper", () => {
  it("produces <= 200 chars hint mentioning memory_search", () => {
    const results = [makeResult(5.0, "docker-build")];
    const whisper = formatWhisper(results, "docker");
    expect(whisper).toContain("memory_search");
    expect(whisper).toContain("docker-build");
    expect(whisper.length).toBeLessThanOrEqual(200);
  });

  it("returns empty string for empty results", () => {
    expect(formatWhisper([], "query")).toBe("");
  });
});
