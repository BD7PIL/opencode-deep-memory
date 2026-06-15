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

  it("emits only stable tool-hint for tool-subagent tier", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "explore");

    const { stable, volatile } = await composeSystemPayload({
      state, sessionID: "sess-1", projectPath, mode: "normal",
    });

    expect(stable).toContain("<deep-memory-stable>");
    expect(stable).toContain("<tool-hint>");
    expect(stable).toContain("memory_search");
    expect(stable).toContain("</deep-memory-stable>");
    expect(volatile).toBe("");
  });

  it("emits stable with empty constraints when no MEMORY.md", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    const { stable, volatile } = await composeSystemPayload({
      state, sessionID: "sess-1", projectPath, mode: "normal",
    });

    expect(stable).toContain("<deep-memory-stable>");
    expect(stable).toContain("<tool-hint>");
    expect(stable).toContain("<constraints>");
    expect(stable).toContain("(empty)");
    expect(stable).toContain("</constraints>");
    expect(volatile).toContain("<deep-memory-volatile>");
  });

  it("emits MEMORY.md content in stable constraints", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    setupMemoryFile("## Rules\nAlways use TypeScript.\n## Decisions\nUse vitest.\n");

    const { stable } = await composeSystemPayload({
      state, sessionID: "sess-1", projectPath, mode: "normal",
    });

    expect(stable).toContain("<constraints>");
    expect(stable).toContain("Always use TypeScript.");
    expect(stable).toContain("</constraints>");
  });

  it("emits checkpoint in volatile when file exists", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "build");

    setupMemoryFile("## Rules\nUse TS.");
    setupCheckpointFile("## User Intent\nBuild auth system.\n## Decisions\nUse JWT.\n");

    const { volatile } = await composeSystemPayload({
      state, sessionID: "sess-1", projectPath, mode: "normal",
    });

    expect(volatile).toContain("<last-checkpoint>");
    expect(volatile).toContain("Build auth system.");
    expect(volatile).toContain("</last-checkpoint>");
  });

  it("works with post-resume mode for main tier", async () => {
    const state = createPluginState();

    const { stable, volatile } = await composeSystemPayload({
      state, sessionID: undefined, projectPath, mode: "post-resume",
    });

    expect(stable).toContain("<deep-memory-stable>");
    expect(stable).toContain("<constraints>");
    expect(volatile).toContain("<deep-memory-volatile>");
  });

  it("produces correct m[0]/m[1] structure for main tier with files", async () => {
    const state = createPluginState();
    state.recordAgent("sess-1", "sisyphus");

    setupMemoryFile("## Rules\nBe concise.");
    setupCheckpointFile("## Decisions\nUse ESM.");

    const { stable, volatile } = await composeSystemPayload({
      state, sessionID: "sess-1", projectPath, mode: "post-compaction",
    });

    expect(stable).toMatch(/<deep-memory-stable>/);
    expect(stable).toMatch(/<tool-hint>.*memory_search.*<\/tool-hint>/s);
    expect(stable).toMatch(/<constraints>[\s\S]*<\/constraints>/);

    expect(volatile).toMatch(/<deep-memory-volatile>/);
    expect(volatile).toMatch(/<relevant>/);
    expect(volatile).toMatch(/<last-checkpoint>[\s\S]*Use ESM[\s\S]*<\/last-checkpoint>/);
    expect(volatile).toMatch(/<\/deep-memory-volatile>/);
  });
});
