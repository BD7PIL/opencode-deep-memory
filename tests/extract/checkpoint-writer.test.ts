/**
 * Tests for checkpoint writer — render + write.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderCheckpoint, writeCheckpoint } from "../../src/extract/checkpoint-writer.js";
import type { HeuristicResult } from "../../src/extract/heuristics.js";

function emptyResult(): HeuristicResult {
  return {
    userIntents: [],
    decisions: [],
    constraints: [],
    gotchas: [],
    fileChanges: [],
  };
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-writer-test-"));
}

describe("renderCheckpoint", () => {
  it("renders header with sessionID, timestamp, and token estimate", () => {
    const md = renderCheckpoint({
      sessionID: "sess-abc",
      tokenEstimate: 42,
      result: emptyResult(),
    });

    expect(md).toContain("# Checkpoint — sess-abc");
    expect(md).toContain("Generated:");
    expect(md).toContain("Session token estimate: 42");
  });

  it("shows _(none captured)_ when userIntents is empty", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 0,
      result: emptyResult(),
    });

    expect(md).toContain("## User Intent");
    expect(md).toContain("_(none captured)_");
  });

  it("renders user intents as bullet list", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 10,
      result: { ...emptyResult(), userIntents: ["Build API", "Add auth"] },
    });

    expect(md).toContain("- Build API");
    expect(md).toContain("- Add auth");
  });

  it("omits Decisions section when empty", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 0,
      result: emptyResult(),
    });

    expect(md).not.toContain("## Decisions");
  });

  it("renders decisions section when present", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 5,
      result: { ...emptyResult(), decisions: ["Use TypeScript"] },
    });

    expect(md).toContain("## Decisions");
    expect(md).toContain("- Use TypeScript");
  });

  it("omits Constraints section when empty", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 0,
      result: emptyResult(),
    });
    expect(md).not.toContain("## Constraints");
  });

  it("renders constraints section when present", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 5,
      result: { ...emptyResult(), constraints: ["Do not use eval"] },
    });
    expect(md).toContain("## Constraints");
    expect(md).toContain("- Do not use eval");
  });

  it("renders gotchas with error → fix format", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 5,
      result: {
        ...emptyResult(),
        gotchas: [{ error: "ENOENT: file not found", fix: "write /src/app.ts" }],
      },
    });

    expect(md).toContain("## Gotchas");
    expect(md).toContain("- Error: ENOENT: file not found → Fix: write /src/app.ts");
  });

  it("renders file changes section", () => {
    const md = renderCheckpoint({
      sessionID: "s1",
      tokenEstimate: 5,
      result: {
        ...emptyResult(),
        fileChanges: [
          { path: "/src/index.ts", operation: "write" },
          { path: "/src/utils.ts", operation: "edit" },
        ],
      },
    });

    expect(md).toContain("## File Changes");
    expect(md).toContain("- /src/index.ts: write");
    expect(md).toContain("- /src/utils.ts: edit");
  });

  it("renders all sections when all are populated", () => {
    const md = renderCheckpoint({
      sessionID: "s-full",
      tokenEstimate: 100,
      result: {
        userIntents: ["Build API"],
        decisions: ["Use TypeScript"],
        constraints: ["No eval"],
        gotchas: [{ error: "err", fix: "fix" }],
        fileChanges: [{ path: "/a.ts", operation: "write" }],
      },
    });

    expect(md).toContain("## User Intent");
    expect(md).toContain("## Decisions");
    expect(md).toContain("## Constraints");
    expect(md).toContain("## Gotchas");
    expect(md).toContain("## File Changes");
  });
});

describe("writeCheckpoint", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = tmpProject();
  });

  it("writes content to checkpoint.md in .deep-memory dir", async () => {
    const content = "# Test checkpoint\nHello world\n";
    const filePath = await writeCheckpoint({ projectPath, sessionID: "s1", content });

    expect(filePath).toContain("checkpoint.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
  });

  it("creates .deep-memory directory if it doesn't exist", async () => {
    const filePath = await writeCheckpoint({
      projectPath,
      sessionID: "s1",
      content: "# test",
    });

    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
  });

  it("overwrites existing checkpoint.md", async () => {
    await writeCheckpoint({ projectPath, sessionID: "s1", content: "first" });
    await writeCheckpoint({ projectPath, sessionID: "s1", content: "second" });

    const filePath = await writeCheckpoint({
      projectPath,
      sessionID: "s1",
      content: "second",
    });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });
});
