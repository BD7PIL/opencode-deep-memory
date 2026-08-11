import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock, tryAcquireLock } from "../../src/shared/lock.js";

describe("acquireLock", () => {
  let tmpDir: string;
  let targetFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-lock-"));
    targetFile = path.join(tmpDir, "MEMORY.md");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("acquires lock and returns release function", async () => {
    const release = await acquireLock(targetFile, { maxWaitMs: 1000 });
    expect(typeof release).toBe("function");
    // Lock file should exist
    expect(fs.existsSync(targetFile + ".lock")).toBe(true);
    release();
    // Lock file should be removed after release
    expect(fs.existsSync(targetFile + ".lock")).toBe(false);
  });

  it("writes pid and time to lock file", async () => {
    const release = await acquireLock(targetFile, { maxWaitMs: 1000 });
    const raw = fs.readFileSync(targetFile + ".lock", "utf8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed.pid).toBe("number");
    expect(typeof parsed.time).toBe("number");
    release();
  });

  it("throws on timeout when lock is held by another live process", async () => {
    // Write a lock file pretending to be another process
    const lockFile = targetFile + ".lock";
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() }), "utf8");

    // Try to acquire — should timeout since the "other process" (us) is alive
    await expect(acquireLock(targetFile, { maxWaitMs: 200, pollMs: 50 }))
      .rejects.toThrow("timed out");
  });

  it("auto-claims stale lock (old timestamp)", async () => {
    const lockFile = targetFile + ".lock";
    // Write a lock with an old timestamp (stale)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() - 60_000 }), "utf8");

    // Should be able to acquire despite the lock file existing
    const release = await acquireLock(targetFile, { maxWaitMs: 1000, ttlMs: 30_000 });
    expect(typeof release).toBe("function");
    release();
  });

  it("auto-claims lock from dead process (non-existent pid)", async () => {
    const lockFile = targetFile + ".lock";
    // Write a lock with a pid that definitely doesn't exist (999999)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, time: Date.now() }), "utf8");

    const release = await acquireLock(targetFile, { maxWaitMs: 1000 });
    expect(typeof release).toBe("function");
    release();
  });

  it("release is idempotent (calling twice does not throw)", async () => {
    const release = await acquireLock(targetFile, { maxWaitMs: 1000 });
    release();
    expect(() => release()).not.toThrow();
  });
});

describe("tryAcquireLock (synchronous)", () => {
  let tmpDir: string;
  let targetFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-lock-try-"));
    targetFile = path.join(tmpDir, "MEMORY.md");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("acquires lock on first try (no competition)", () => {
    const release = tryAcquireLock(targetFile);
    expect(release).not.toBeNull();
    expect(typeof release).toBe("function");
    if (release) release();
  });

  it("returns null when lock is held by a live process", () => {
    // Write a live-process lock
    fs.writeFileSync(
      targetFile + ".lock",
      JSON.stringify({ pid: process.pid, time: Date.now() }),
      "utf8",
    );
    const release = tryAcquireLock(targetFile);
    expect(release).toBeNull();
  });

  it("claims stale lock", () => {
    // Write a stale lock
    fs.writeFileSync(
      targetFile + ".lock",
      JSON.stringify({ pid: process.pid, time: Date.now() - 60_000 }),
      "utf8",
    );
    const release = tryAcquireLock(targetFile, { ttlMs: 30_000 });
    expect(release).not.toBeNull();
    if (release) release();
  });
});
