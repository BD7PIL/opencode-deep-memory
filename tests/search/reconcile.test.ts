import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BM25Index } from "../../src/search/bm25.js";
import { Reconciler } from "../../src/search/reconcile.js";

function createTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
}

describe("Reconciler", () => {
  let tmpDir: string;
  let projectPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = createTmpDir();
    projectPath = tmpDir;
    prevEnv = process.env["DEEP_MEMORY_GLOBAL_ROOT"];
    process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) {
      delete process.env["DEEP_MEMORY_GLOBAL_ROOT"];
    } else {
      process.env["DEEP_MEMORY_GLOBAL_ROOT"] = prevEnv;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function writeMd(relativePath: string, content: string): string {
    const fullPath = path.join(tmpDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  it("syncs global MEMORY.md", async () => {
    writeMd("global/MEMORY.md", "## Decisions\n- Use BM25\n## Constraints\n- No native addons");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.sync();
    expect(result.added).toBe(1);
    expect(index.size).toBe(2);
  });

  it("syncs project MEMORY.md", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Notes\n- Some note here");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.sync();
    expect(result.added).toBe(1);
    expect(index.size).toBe(1);
  });

  it("syncs session checkpoint.md", async () => {
    writeMd(
      ".deep-memory/sessions/sess-123/checkpoint.md",
      "## Decisions\n- Use TypeScript",
    );

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.sync();
    expect(result.added).toBe(1);
    expect(index.size).toBe(1);
  });

  it("detects modified files on re-sync", async () => {
    const filePath = writeMd(
      ".deep-memory/MEMORY.md",
      "## Decisions\n- Original content",
    );

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    await reconciler.sync();
    expect(index.size).toBe(1);

    writeFileSync(filePath, "## Decisions\n- Updated content\n## New Section\n- Brand new", "utf8");

    const result = await reconciler.sync();
    expect(result.modified).toBe(1);
    expect(index.size).toBe(2);
  });

  it("detects deleted files on re-sync", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Will be deleted");
    writeMd(".deep-memory/notes.md", "## Notes\n- Will survive");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    await reconciler.sync();
    expect(index.size).toBe(2);

    await fs.unlink(path.join(tmpDir, ".deep-memory/MEMORY.md"));

    const result = await reconciler.sync();
    expect(result.removed).toBe(1);
    expect(index.size).toBe(1);
  });

  it("rebuild clears and re-indexes everything", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Use BM25");
    writeMd(".deep-memory/notes.md", "## Notes\n- Raw capture");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.rebuild();
    expect(result.total).toBe(2);
    expect(index.size).toBe(2);
  });

  it("handles missing directories gracefully", async () => {
    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.sync();
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
    expect(index.size).toBe(0);
  });

  it("skips non-.md files", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Indexed");
    writeMd(".deep-memory/.schedule.json", '{"lastDream":"2026-01-01"}');
    writeMd(".deep-memory/checkpoint.raw.json", '{"messages":[]}');

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    const result = await reconciler.sync();
    expect(result.added).toBe(1);
    expect(index.size).toBe(1);
  });

  it("persists index state to .index-state.json", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Persist me");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    await reconciler.sync();

    const statePath = path.join(tmpDir, ".deep-memory/.index-state.json");
    expect(existsSync(statePath)).toBe(true);

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const keys = Object.keys(state);
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("MEMORY.md");
  });

  it("idempotent sync (no changes = no diff)", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Stable");

    const index = new BM25Index();
    const reconciler = new Reconciler({
      dataRoot: tmpDir,
      projectPath,
      index,
    });

    await reconciler.sync();
    const result = await reconciler.sync();
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
  });
});
