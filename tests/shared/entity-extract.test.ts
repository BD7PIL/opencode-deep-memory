import { describe, it, expect } from "vitest";
import { extractEntities, entityOverlap, ENTITY_BOOST_WEIGHT } from "../../src/shared/entity-extract.js";

describe("extractEntities (G2 Mem0 pattern)", () => {
  it("extracts file names with extensions", () => {
    const entities = extractEntities("Edit consolidate.ts and memory-store.js");
    expect(entities).toContain("consolidate.ts");
    expect(entities).toContain("memory-store.js");
  });

  it("extracts function calls with parens", () => {
    const entities = extractEntities("Call buildPrompt() to generate the prompt");
    expect(entities).toContain("buildprompt()");
  });

  it("extracts version numbers", () => {
    const entities = extractEntities("Requires Python 3.6.8 and Node 22.5.1");
    expect(entities).toContain("3.6.8");
    expect(entities).toContain("22.5.1");
  });

  it("extracts PascalCase identifiers", () => {
    const entities = extractEntities("WLG5144 uses OpenShortPlus for testing");
    expect(entities).toContain("wlg5144");
    expect(entities).toContain("openshortplus");
  });

  it("filters stopwords (The, This, That, etc.)", () => {
    const entities = extractEntities("The This That These Those");
    // All common stopwords should be filtered
    expect(entities).not.toContain("the");
    expect(entities).not.toContain("this");
    expect(entities).not.toContain("that");
  });

  it("filters tokens shorter than 3 chars", () => {
    const entities = extractEntities("a b c ab");
    expect(entities).toHaveLength(0);
  });

  it("returns lowercase entities", () => {
    const entities = extractEntities("WLG5144 TypeScript");
    expect(entities.every((e) => e === e.toLowerCase())).toBe(true);
  });

  it("deduplicates identical entities", () => {
    const entities = extractEntities("WLG5144 WLG5144 WLG5144");
    const unique = [...new Set(entities)];
    expect(entities).toEqual(unique);
  });

  it("returns empty array for plain text with no entities", () => {
    const entities = extractEntities("just some plain text without code");
    expect(entities.length).toBe(0);
  });
});

describe("entityOverlap (Jaccard similarity)", () => {
  it("returns 0 for no overlap", () => {
    expect(entityOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("returns 1.0 for identical sets", () => {
    expect(entityOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns 0 for empty inputs", () => {
    expect(entityOverlap([], ["a"])).toBe(0);
    expect(entityOverlap(["a"], [])).toBe(0);
    expect(entityOverlap([], [])).toBe(0);
  });

  it("computes correct Jaccard ratio", () => {
    // {a,b,c} ∩ {a,b,d} = {a,b} (2), ∪ = {a,b,c,d} (4) → 0.5
    expect(entityOverlap(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(0.5);
  });
});

describe("ENTITY_BOOST_WEIGHT", () => {
  it("is 1.5 (Mem0 standard)", () => {
    expect(ENTITY_BOOST_WEIGHT).toBe(1.5);
  });
});
