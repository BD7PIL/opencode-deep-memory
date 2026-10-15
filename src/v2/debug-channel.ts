/** Debug-channel helper for the v2 entry — appends to the same file-based log
 *  the v1 logger uses (DEEP_MEMORY_DEBUG gated), without instantiating the
 *  full logger. Kept dependency-free and fail-safe. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

let ensured = false;

export function appendDebugLine(line: string): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const v = env["DEEP_MEMORY_DEBUG"];
  if (!v || v === "0" || v === "false") return;
  const file = env["DEEP_MEMORY_LOG_FILE"] ?? join(homedir(), ".config", "opencode", "deep-memory-debug.log");
  if (!ensured) {
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* best-effort */ }
    ensured = true;
  }
  try { appendFileSync(file, `[${new Date().toISOString()}] [INFO] ${line}\n`); } catch { /* best-effort */ }
}
