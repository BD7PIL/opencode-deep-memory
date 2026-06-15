/**
 * Simple file lock with pid + timestamp. 30s TTL by default.
 *
 * Used to coordinate writes to MEMORY.md / notes.md / checkpoint.md across
 * concurrent sessions (main session + background dream session).
 *
 * Lock file format: `<target>.lock` containing JSON `{ pid, time }`.
 * Stale locks (older than TTL or whose pid is dead) are auto-claimed.
 */

import fs from "node:fs";
import path from "node:path";

export interface LockInfo {
  pid: number;
  time: number; // epoch ms
}

export interface LockOptions {
  /** Lock TTL in ms. Default 30_000. */
  ttlMs?: number;
  /** Polling interval in ms when waiting. Default 100. */
  pollMs?: number;
  /** Max total wait time in ms. Default 5_000. */
  maxWaitMs?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 5_000;

function lockPath(targetFile: string): string {
  return targetFile + ".lock";
}

function readLock(lockFile: string): LockInfo | undefined {
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const parsed = JSON.parse(raw) as LockInfo;
    if (typeof parsed.pid === "number" && typeof parsed.time === "number") {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeLock(lockFile: string, info: LockInfo): void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(info), "utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 = existence check
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(info: LockInfo, ttlMs: number): boolean {
  const age = Date.now() - info.time;
  if (age > ttlMs) return true;
  if (!isProcessAlive(info.pid)) return true;
  return false;
}

/**
 * Acquire a lock for the target file. Resolves when acquired or rejects on timeout.
 *
 * Returns a release function that MUST be called in a finally block.
 *
 * Uses O_EXCL (atomic exclusive create) to eliminate TOCTOU race conditions
 * under high concurrency.
 */
export async function acquireLock(
  targetFile: string,
  opts: LockOptions = {},
): Promise<() => void> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const lockFile = lockPath(targetFile);
  const start = Date.now();
  const myInfo: LockInfo = { pid: process.pid, time: Date.now() };

  for (;;) {
    // Try atomic exclusive create — eliminates race condition
    let acquired = false;
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, JSON.stringify(myInfo));
      fs.closeSync(fd);
      acquired = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const existing = readLock(lockFile);
        if (existing && isStale(existing, ttlMs)) {
          // Forcefully reclaim stale lock
          try {
            fs.unlinkSync(lockFile);
          } catch {
            /* someone else already cleaned it */
          }
        }
      }
    }

    if (acquired) {
      return () => {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* already gone — fine */
        }
      };
    }

    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `Lock acquisition timed out after ${maxWaitMs}ms for ${targetFile}`,
      );
    }
    await sleep(pollMs);
  }
}

/** Synchronous variant — tries once, does not wait. Returns release fn or null. */
export function tryAcquireLock(
  targetFile: string,
  opts: Pick<LockOptions, "ttlMs"> = {},
): (() => void) | null {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const lockFile = lockPath(targetFile);
  const existing = readLock(lockFile);
  if (existing && !isStale(existing, ttlMs)) return null;
  writeLock(lockFile, { pid: process.pid, time: Date.now() });
  const confirmed = readLock(lockFile);
  if (confirmed && confirmed.pid === process.pid) {
    return () => {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
