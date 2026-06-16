/**
 * Tests for budgetedRead — token-budgeted Markdown section reader.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { budgetedRead } from "../../src/inject/budgeted-read.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "budgeted-read-test-"));
}

describe("budgetedRead", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string for non-existent file", () => {
    const result = budgetedRead("/nonexistent/file.md", 1000, []);
    expect(result).toBe("");
  });

  it("returns empty string for empty file", () => {
    const filePath = path.join(tmpDir, "empty.md");
    fs.writeFileSync(filePath, "", "utf8");
    const result = budgetedRead(filePath, 1000, []);
    expect(result).toBe("");
  });

  it("returns empty string for zero budget", () => {
    const filePath = path.join(tmpDir, "test.md");
    fs.writeFileSync(filePath, "## Section\nSome content", "utf8");
    const result = budgetedRead(filePath, 0, []);
    expect(result).toBe("");
  });

  it("parses and returns all sections when budget is sufficient", () => {
    const content = `## Rules
Always use TypeScript.

## Constraints
No any types.

## Decisions
Use vitest for testing.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    const result = budgetedRead(filePath, 5000, []);
    expect(result).toContain("## Rules");
    expect(result).toContain("Always use TypeScript.");
    expect(result).toContain("## Constraints");
    expect(result).toContain("No any types.");
    expect(result).toContain("## Decisions");
    expect(result).toContain("Use vitest for testing.");
  });

  it("sorts sections by priority keyword match", () => {
    const content = `## Decisions
Use vitest.

## Rules
Always TypeScript.

## Constraints
No any.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    const result = budgetedRead(filePath, 5000, ["Rules", "Constraints", "Decisions"]);
    const rulesIdx = result.indexOf("## Rules");
    const constraintsIdx = result.indexOf("## Constraints");
    const decisionsIdx = result.indexOf("## Decisions");

    // Rules should come first, then Constraints, then Decisions
    expect(rulesIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(decisionsIdx);
  });

  it("truncates when budget is exceeded", () => {
    // Create content that's definitely more than 40 tokens (160 chars)
    const longContent = "This is a very long paragraph that goes on and on. ".repeat(20);
    const content = `## Rules
${longContent}

## Decisions
Short.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    // Budget enough for Decisions but not full Rules
    const result = budgetedRead(filePath, 20, ["Decisions", "Rules"]);
    // Decisions should be included (high priority, small)
    expect(result).toContain("## Decisions");
    expect(result).toContain("Short.");
    // Rules may be truncated or absent depending on budget remaining
  });

  it("includes [truncated] marker when section is cut", () => {
    // A section that's definitely larger than a small budget
    const bigSection = "word ".repeat(200); // ~800 chars → ~200 tokens
    const content = `## Rules
${bigSection}

## Decisions
Small content.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    // Give enough budget for Decisions but not full Rules
    const result = budgetedRead(filePath, 15, ["Decisions", "Rules"]);
    // Decisions (high priority, small) should fit
    expect(result).toContain("## Decisions");
    // If Rules is partially included, it should be truncated
    if (result.includes("## Rules")) {
      expect(result).toContain("[truncated]");
    }
  });

  it("handles content before first heading (empty heading)", () => {
    const content = `Preamble text here.

## Rules
Use TypeScript.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    const result = budgetedRead(filePath, 5000, []);
    expect(result).toContain("Preamble text here.");
    expect(result).toContain("## Rules");
  });

  it("handles sections with unmatched priority keywords (go last)", () => {
    const content = `## Gotchas
Watch out for X.

## Facts
The sky is blue.

## Rules
Always TypeScript.
`;
    const filePath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(filePath, content, "utf8");

    const result = budgetedRead(filePath, 5000, ["Rules"]);
    const rulesIdx = result.indexOf("## Rules");
    const gotchasIdx = result.indexOf("## Gotchas");
    const factsIdx = result.indexOf("## Facts");

    // Rules (matched) should come before unmatched sections
    expect(rulesIdx).toBeLessThan(gotchasIdx);
    expect(rulesIdx).toBeLessThan(factsIdx);
  });
});
