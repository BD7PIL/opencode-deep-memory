import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RepoMapTracker } from "../../src/repomap/tracker.js";
import { composeSystemPayload } from "../../src/inject/system-payload.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { renderCheckpoint } from "../../src/extract/checkpoint-writer.js";
import type { HeuristicResult } from "../../src/extract/heuristics.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "repomap-integration-"));
}

describe("repomap integration", () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    projectPath = tmpDir;
    process.env["DEEP_MEMORY_DATA"] = path.join(tmpDir, "data");
  });

  afterEach(() => {
    delete process.env["DEEP_MEMORY_DATA"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracker symbols appear in system-payload volatile injection", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    const tracker = new RepoMapTracker();
    tracker.recordRead("src/auth.ts", [
      "export function login() { }",
      "export function logout() { }",
    ].join("\n"));
    tracker.recordRead("src/db.ts", [
      "export function connect() { }",
    ].join("\n"));

    const { volatile } = await composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
      tracker,
    });

    expect(volatile).toContain("<deep-memory-repomap>");
    expect(volatile).toContain("src/auth.ts:");
    expect(volatile).toContain("login");
    expect(volatile).toContain("logout");
    expect(volatile).toContain("src/db.ts:");
    expect(volatile).toContain("connect");
    expect(volatile).toContain("</deep-memory-repomap>");
  });

  it("system-payload without tracker omits repomap", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    const { volatile } = await composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
    });

    expect(volatile).not.toContain("<deep-memory-repomap>");
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
