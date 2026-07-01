import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderCheckpoint } from "../../src/extract/checkpoint-writer.js";
import type { HeuristicResult } from "../../src/extract/heuristics.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "repomap-integration-"));
}

describe("repomap integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env["DEEP_MEMORY_DATA"] = path.join(tmpDir, "data");
  });

  afterEach(() => {
    delete process.env["DEEP_MEMORY_DATA"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renderCheckpoint includes folded file context", () => {
    const result: HeuristicResult = {
      userIntents: ["Build auth"],
      decisions: ["Use JWT"],
      constraints: [],
      gotchas: [],
      fileChanges: [],
    };

    const foldedContext = [
      "src/auth.ts:",
      "  login, logout, validateToken",
      "src/db.ts:",
      "  connect, query",
    ].join("\n");

    const md = renderCheckpoint({
      sessionID: "test-session",
      tokenEstimate: 100,
      result,
      foldedContext,
    });

    expect(md).toContain("## Folded File Context");
    expect(md).toContain("src/auth.ts:");
    expect(md).toContain("login, logout, validateToken");
    expect(md).toContain("src/db.ts:");
    expect(md).toContain("connect, query");
  });

  it("renderCheckpoint omits folded section when no foldedContext", () => {
    const result: HeuristicResult = {
      userIntents: ["Build auth"],
      decisions: [],
      constraints: [],
      gotchas: [],
      fileChanges: [],
    };

    const md = renderCheckpoint({
      sessionID: "test-session",
      tokenEstimate: 50,
      result,
    });

    expect(md).not.toContain("## Folded File Context");
  });
});
