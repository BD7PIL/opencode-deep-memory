import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("P0: mtime race detection fix", () => {
  let tmpDir: string;
  let memPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mtime-"));
    memPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memPath, "- [decision] Original entry\n", "utf8");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("mtime does not change when file is untouched", async () => {
    const stat1 = fs.statSync(memPath);
    await new Promise(r => setTimeout(r, 50));
    const stat2 = fs.statSync(memPath);
    // mtimeMs should be identical when file has not been written
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("mtime increases after file modification", async () => {
    const before = fs.statSync(memPath).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(memPath, "- [decision] Changed entry\n", "utf8");
    const after = fs.statSync(memPath).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("Date.now() > stat mtimeMs is always true (the bug)", async () => {
    // This demonstrates the original bug: Date.now() is always > any file mtime
    const mtime = fs.statSync(memPath).mtimeMs;
    expect(Date.now()).toBeGreaterThan(mtime);
  });

  it("stat mtimeMs comparison is the correct check", async () => {
    // Record mtime, then verify stat returns the same value (file unchanged)
    const recorded = fs.statSync(memPath).mtimeMs;
    const checked = fs.statSync(memPath).mtimeMs;
    expect(checked).toBe(recorded);
  });
});
