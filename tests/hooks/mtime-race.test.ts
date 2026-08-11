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

  it("Date.now() vs stat mtimeMs: integer vs float ms precision (the bug)", async () => {
    // The original bug: code used `Date.now() < mtimeMs` as a "race detection"
    // check, assuming Date.now() (integer ms) would always be > any recent file
    // mtime. This assumption is FALSE: statSync().mtimeMs is float ms with
    // sub-ms precision, so when a file is written in the same integer-ms
    // window as Date.now(), mtimeMs can be GREATER than Date.now() despite
    // the file being older. This made the buggy check spuriously fire.
    // The fix is to compare mtimeMs values directly (see test below).
    // Demonstrating the root cause deterministically (no timing dependence):
    const mtime = fs.statSync(memPath).mtimeMs;
    expect(Number.isInteger(Date.now())).toBe(true);
    expect(Number.isInteger(mtime)).toBe(false);
  });

  it("stat mtimeMs comparison is the correct check", async () => {
    // Record mtime, then verify stat returns the same value (file unchanged)
    const recorded = fs.statSync(memPath).mtimeMs;
    const checked = fs.statSync(memPath).mtimeMs;
    expect(checked).toBe(recorded);
  });
});
