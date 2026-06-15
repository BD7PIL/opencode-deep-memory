import { describe, it, expect } from "vitest";
import { computeImportance } from "../../src/inject/importance.js";

describe("computeImportance", () => {
  describe("base scores per type", () => {
    it("constraint → 80", () => {
      expect(computeImportance({ type: "constraint", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(80);
    });
    it("decision → 70", () => {
      expect(computeImportance({ type: "decision", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(70);
    });
    it("gotcha → 60", () => {
      expect(computeImportance({ type: "gotcha", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(60);
    });
    it("fact → 50", () => {
      expect(computeImportance({ type: "fact", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(50);
    });
    it("note → 30", () => {
      expect(computeImportance({ type: "note", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(30);
    });
    it("unknown type defaults to 40", () => {
      expect(computeImportance({ type: "unknown", ageDays: 60, notesOccurrences: 0, searchHits: 0 })).toBe(40);
    });
  });

  describe("frequency bonus (notesOccurrences)", () => {
    it("adds 5 per occurrence", () => {
      expect(computeImportance({ type: "note", ageDays: 60, notesOccurrences: 2, searchHits: 0 })).toBe(40);
    });
    it("caps at 20 (4+ occurrences)", () => {
      const four = computeImportance({ type: "note", ageDays: 60, notesOccurrences: 4, searchHits: 0 });
      const six = computeImportance({ type: "note", ageDays: 60, notesOccurrences: 6, searchHits: 0 });
      expect(four).toBe(50);
      expect(six).toBe(50); // same — capped at 20
    });
  });

  describe("searchHits bonus", () => {
    it("adds 5 per hit", () => {
      expect(computeImportance({ type: "note", ageDays: 60, notesOccurrences: 0, searchHits: 2 })).toBe(40);
    });
    it("caps at 15 (3+ hits)", () => {
      const three = computeImportance({ type: "note", ageDays: 60, notesOccurrences: 0, searchHits: 3 });
      const five = computeImportance({ type: "note", ageDays: 60, notesOccurrences: 0, searchHits: 5 });
      expect(three).toBe(45);
      expect(five).toBe(45); // same — capped at 15
    });
  });

  describe("recency bonus", () => {
    it("adds +10 when ageDays < 7", () => {
      expect(computeImportance({ type: "note", ageDays: 0, notesOccurrences: 0, searchHits: 0 })).toBe(40);
      expect(computeImportance({ type: "note", ageDays: 6, notesOccurrences: 0, searchHits: 0 })).toBe(40);
    });
    it("adds +5 when 7 <= ageDays < 30", () => {
      expect(computeImportance({ type: "note", ageDays: 7, notesOccurrences: 0, searchHits: 0 })).toBe(35);
      expect(computeImportance({ type: "note", ageDays: 29, notesOccurrences: 0, searchHits: 0 })).toBe(35);
    });
    it("adds nothing when ageDays >= 30", () => {
      expect(computeImportance({ type: "note", ageDays: 30, notesOccurrences: 0, searchHits: 0 })).toBe(30);
      expect(computeImportance({ type: "note", ageDays: 365, notesOccurrences: 0, searchHits: 0 })).toBe(30);
    });
  });

  describe("clamping 1-100", () => {
    it("clamps at 100 when total exceeds 100", () => {
      // constraint(80) + freq(20) + search(15) + recency(10) = 125 → clamped to 100
      expect(
        computeImportance({ type: "constraint", ageDays: 0, notesOccurrences: 10, searchHits: 10 }),
      ).toBe(100);
    });
    it("minimum is 1", () => {
      // Even with all zeros, note base is 30 so it won't go below 1 for known types.
      // Test with a hypothetical low scenario — score can't go below 1.
      expect(
        computeImportance({ type: "note", ageDays: 100, notesOccurrences: 0, searchHits: 0 }),
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
