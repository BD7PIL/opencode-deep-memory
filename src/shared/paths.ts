/**
 * Project-local + global hybrid storage layout.
 *
 *   <projectPath>/.deep-memory/                  ← project-scoped (visible, VCS-friendly)
 *   ├── MEMORY.md                                  persistent memory
 *   ├── notes.md                                   keyword captures
 *   ├── checkpoint.md                              last compaction extraction
 *   ├── checkpoint.raw.json                        raw messages dump (compacting hook)
 *   ├── .schedule.json                             dream scheduling state
 *   ├── .index-state.json                          mtime map for reconcile
 *   └── sessions/<sessionID>/checkpoint.md         per-session archive
 *
 *   <globalRoot>/global/MEMORY.md                  ← cross-project memory
 *   (globalRoot defaults to ~/.local/share/opencode/deep-memory/)
 *
 * Configuration via env:
 *   DEEP_MEMORY_PROJECT_SUBDIR  (default: .deep-memory)   project-local subdir name
 *   DEEP_MEMORY_GLOBAL_ROOT     (default: XDG/homedir)    global memory root
 *   DEEP_MEMORY_DATA            (legacy alias for GLOBAL_ROOT)
 */

import path from "node:path";
import os from "node:os";

export type Scope = "global" | "project" | "session";
export type MemoryType = "memory" | "notes" | "checkpoint";

/** Project-local subdir name (override via DEEP_MEMORY_PROJECT_SUBDIR). */
export function projectSubdir(env: NodeJS.ProcessEnv = process.env): string {
  return env["DEEP_MEMORY_PROJECT_SUBDIR"] ?? ".deep-memory";
}

/** Resolve the global memory root (for cross-project MEMORY.md). */
export function resolveGlobalRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env["DEEP_MEMORY_GLOBAL_ROOT"]) {
    return path.resolve(env["DEEP_MEMORY_GLOBAL_ROOT"]);
  }
  // Backwards-compat alias
  if (env["DEEP_MEMORY_DATA"]) {
    return path.resolve(env["DEEP_MEMORY_DATA"]);
  }
  if (env["XDG_DATA_HOME"]) {
    return path.join(env["XDG_DATA_HOME"], "opencode", "deep-memory");
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "deep-memory");
}

/** Legacy alias kept for callers that haven't migrated. Prefer resolveGlobalRoot(). */
export const resolveDataRoot = resolveGlobalRoot;

/** Directory for project-scoped memory: <projectPath>/<subdir>. */
export function projectMemoryDir(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(projectPath, projectSubdir(env));
}

/** Directory for global memory: <globalRoot>/global. */
export function globalMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGlobalRoot(env), "global");
}

/** Return absolute directory for a (scope, projectPath, sessionID?) tuple. */
export function scopeDir(
  scope: Scope,
  projectPath: string,
  sessionID?: string,
  _legacyDataRoot?: string,
): string {
  switch (scope) {
    case "global":
      return globalMemoryDir();
    case "project":
      return projectMemoryDir(projectPath);
    case "session": {
      if (!sessionID) {
        throw new Error("scopeDir(session) requires sessionID");
      }
      return path.join(projectMemoryDir(projectPath), "sessions", sessionID);
    }
  }
}

/** Resolve the absolute file path for a memory entry. */
export function memoryFilePath(
  scope: Scope,
  type: MemoryType,
  projectPath: string,
  sessionID?: string,
  _legacyDataRoot?: string,
): string {
  const dir = scopeDir(scope, projectPath, sessionID);
  const file =
    type === "memory"
      ? "MEMORY.md"
      : type === "notes"
        ? "notes.md"
        : "checkpoint.md";
  return path.join(dir, file);
}

/** Path for the project-scoped schedule file. */
export function scheduleFilePath(
  projectPath: string,
  _legacyDataRoot?: string,
): string {
  return path.join(projectMemoryDir(projectPath), ".schedule.json");
}

/** Path for the project-scoped index state file (mtime map for reconcile diff). */
export function indexStateFilePath(
  projectPath: string,
  _legacyDataRoot?: string,
): string {
  return path.join(projectMemoryDir(projectPath), ".index-state.json");
}

/** Path for checkpoint raw JSON dump (compacting hook capture). */
export function checkpointRawPath(
  projectPath: string,
  _sessionID: string,
  _legacyDataRoot?: string,
): string {
  return path.join(projectMemoryDir(projectPath), "checkpoint.raw.json");
}

/** Per-session checkpoint directory. */
export function sessionCheckpointDir(
  projectPath: string,
  sessionID: string,
  _legacyDataRoot?: string,
): string {
  return path.join(projectMemoryDir(projectPath), "sessions", sessionID);
}

/**
 * @deprecated Kept for log/debug identification only — no longer used for path construction.
 * Returns a short stable identifier for a project path (useful in logs).
 */
export function hashProject(absProjectPath: string): string {
  // Lazy-load crypto only when actually needed
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const normalized = path.resolve(absProjectPath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
