/**
 * Tests for system-payload — composeSystemPayload.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { composeSystemPayload } from "../../src/inject/system-payload.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { memoryFilePath } from "../../src/shared/paths.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "system-payload-test-"));
}

describe("composeSystemPayload", () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    projectPath = tmpDir;
    // Set env to use tmpDir as data root
    process.env["DEEP_MEMORY_DATA"] = path.join(tmpDir, "data");
  });

  afterEach(() => {
    delete process.env["DEEP_MEMORY_DATA"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupMemoryFile(content: string): void {
    const memPath = memoryFilePath("project", "memory", projectPath);
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, content, "utf8");
  }

  function setupCheckpointFile(content: string): void {
    const cpPath = memoryFilePath("project", "checkpoint", projectPath);
    fs.mkdirSync(path.dirname(cpPath), { recursive: true });
    fs.writeFileSync(cpPath, content, "utf8");
  }

  it("emits only tool-hint for tool-subagent tier", () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "explore");

    const result = composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
    });

    expect(result).toContain("<deep-memory>");
    expect(result).toContain("<tool-hint>");
    expect(result).toContain("memory_search");
    expect(result).not.toContain("<persistent-memory>");
    expect(result).not.toContain("<last-checkpoint>");
    expect(result).toContain("</deep-memory>");
  });

  it("emits persistent-memory with '(empty)' when no MEMORY.md exists", () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    const result = composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
    });

    expect(result).toContain("<deep-memory>");
    expect(result).toContain("<tool-hint>");
    expect(result).toContain("<persistent-memory>");
    expect(result).toContain("(empty — no persistent memory yet)");
    expect(result).toContain("</persistent-memory>");
    expect(result).toContain("</deep-memory>");
  });

  it("emits MEMORY.md content when file exists", () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    setupMemoryFile("## Rules\nAlways use TypeScript.\n## Decisions\nUse vitest.\n");

    const result = composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
    });

    expect(result).toContain("<persistent-memory>");
    expect(result).toContain("Always use TypeScript.");
    expect(result).toContain("</persistent-memory>");
  });

  it("emits checkpoint when file exists and budget allows", () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    setupMemoryFile("## Rules\nUse TS.");
    setupCheckpointFile(
      "## User Intent\nBuild auth system.\n## Decisions\nUse JWT.\n",
    );

    const result = composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "normal",
    });

    expect(result).toContain("<last-checkpoint>");
    expect(result).toContain("Build auth system.");
    expect(result).toContain("</last-checkpoint>");
  });

  it("uses post-resume budget when sessionID is undefined (defaults to main tier)", () => {
    const state = createPluginState();

    const result = composeSystemPayload({
      state,
      sessionID: undefined,
      projectPath,
      mode: "post-resume",
    });

    // With undefined sessionID, agentOf returns undefined → main tier → post-resume = 3000t
    expect(result).toContain("<deep-memory>");
    expect(result).toContain("<persistent-memory>");
  });

  it("produces correct structure with all XML tags for main tier with files", () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "sisyphus");

    setupMemoryFile("## Rules\nBe concise.");
    setupCheckpointFile("## Decisions\nUse ESM.");

    const result = composeSystemPayload({
      state,
      sessionID: "sess-1",
      projectPath,
      mode: "post-compaction",
    });

    // Verify XML structure
    expect(result).toMatch(/<deep-memory>/);
    expect(result).toMatch(/<tool-hint>.*memory_search.*<\/tool-hint>/s);
    expect(result).toMatch(/<persistent-memory>[\s\S]*<\/persistent-memory>/);
    expect(result).toMatch(/<last-checkpoint>[\s\S]*<\/last-checkpoint>/);
    expect(result).toMatch(/<\/deep-memory>/);
  });
});
