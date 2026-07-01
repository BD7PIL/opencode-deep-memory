import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { composeSystemPayload } from "../../src/inject/system-payload.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { memoryFilePath } from "../../src/shared/paths.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "system-payload-v4-"));
}

describe("composeSystemPayload V4 (frozen TOOL_HINT + mtime-cached MEMORY.md)", () => {
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

  it("returns frozen TOOL_HINT containing memory tool names", async () => {
    const state = createPluginState();
    const { payload } = await composeSystemPayload({ state, projectPath });
    expect(payload).toContain("memory_search");
    expect(payload).toContain("memory_store");
    expect(payload).toContain("memory_forget");
  });

  it("includes MEMORY.md content in payload when file exists", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nAlways use TypeScript.\n## Decisions\nUse vitest.\n");
    const { payload } = await composeSystemPayload({ state, projectPath });
    expect(payload).toContain("Always use TypeScript");
    expect(payload).toContain("Use vitest");
  });

  it("does NOT include MEMORY.md content when file is absent", async () => {
    const state = createPluginState();
    const { payload } = await composeSystemPayload({ state, projectPath });
    // TOOL_HINT is present, but no memory content
    expect(payload).toContain("memory_search");
    expect(payload).not.toContain("Always use TypeScript");
  });

  it("reports cacheMiss on first call", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nRule A\n");
    const { cacheHit } = await composeSystemPayload({ state, projectPath });
    expect(cacheHit).toBe(false);
  });

  it("reports cacheHit on second call when MEMORY.md unchanged", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nRule A\n");
    await composeSystemPayload({ state, projectPath });
    const { cacheHit } = await composeSystemPayload({ state, projectPath });
    expect(cacheHit).toBe(true);
  });

  it("reports cacheMiss when MEMORY.md mtime changes", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nRule A\n");
    await composeSystemPayload({ state, projectPath });

    // Simulate mtime change (rewrite file)
    const memPath = memoryFilePath("project", "memory", projectPath);
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(memPath, "## Rules\nRule B\n", "utf8");

    const { cacheHit, payload } = await composeSystemPayload({ state, projectPath });
    expect(cacheHit).toBe(false);
    expect(payload).toContain("Rule B");
    expect(payload).not.toContain("Rule A");
  });

  it("produces byte-identical payload across calls when MEMORY.md unchanged", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nRule A\n## Decisions\nUse X.\n");
    const first = await composeSystemPayload({ state, projectPath });
    const second = await composeSystemPayload({ state, projectPath });
    expect(second.payload).toBe(first.payload);
  });

  it("does NOT include any BM25 search results or repomap", async () => {
    const state = createPluginState();
    setupMemoryFile("## Rules\nRule A\n");
    const { payload } = await composeSystemPayload({ state, projectPath });
    expect(payload).not.toContain("<deep-memory-volatile>");
    expect(payload).not.toContain("<relevant>");
    expect(payload).not.toContain("repomap");
    expect(payload).not.toContain("repo-map");
  });
});
