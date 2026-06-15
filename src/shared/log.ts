/**
 * File-based debug logger. Zero console pollution.
 *
 * Activation:
 *   - DEEP_MEMORY_DEBUG=1   → info+ level
 *   - DEEP_MEMORY_DEBUG=trace → trace level (dumps hook I/O to trace dir)
 *
 * Default log path: ~/.config/opencode/deep-memory-debug.log
 * Override with: DEEP_MEMORY_LOG_FILE=/path/to/log
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function resolveLogLevel(env: NodeJS.ProcessEnv): LogLevel | null {
  const v = env["DEEP_MEMORY_DEBUG"];
  if (!v) return null;
  if (v === "trace") return "trace";
  if (v === "0" || v === "false") return null;
  return "debug";
}

function resolveLogFile(env: NodeJS.ProcessEnv): string {
  if (env["DEEP_MEMORY_LOG_FILE"]) return env["DEEP_MEMORY_LOG_FILE"];
  return path.join(os.homedir(), ".config", "opencode", "deep-memory-debug.log");
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  trace(msg: string, meta?: Record<string, unknown>): void;
  /** Create a child logger with a fixed hook/component prefix. */
  for(component: string): Logger;
  /** Trace dir for hook I/O dumps. */
  traceDir(): string | null;
}

export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const level = resolveLogLevel(env);
  const logFile = resolveLogFile(env);
  const traceDir =
    level === "trace"
      ? path.join(path.dirname(logFile), "deep-memory-trace")
      : null;

  // Ensure log dir exists (lazy — only on first write).
  let logDirEnsured = false;
  function ensureLogDir() {
    if (logDirEnsured) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (traceDir) fs.mkdirSync(traceDir, { recursive: true });
    } catch {
      /* best-effort */
    }
    logDirEnsured = true;
  }

  function shouldLog(l: LogLevel): boolean {
    return level !== null && LEVEL_RANK[l] <= LEVEL_RANK[level];
  }

  function write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (!shouldLog(level)) return;
    ensureLogDir();
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    const lineWithMeta = meta ? `${line} ${JSON.stringify(meta)}` : line;
    try {
      fs.appendFileSync(logFile, lineWithMeta + "\n", "utf8");
    } catch {
      /* swallow — logging must never throw */
    }
  }

  function make(component: string): Logger {
    return {
      error: (m, meta) => write("error", `[${component}] ${m}`, meta),
      warn: (m, meta) => write("warn", `[${component}] ${m}`, meta),
      info: (m, meta) => write("info", `[${component}] ${m}`, meta),
      debug: (m, meta) => write("debug", `[${component}] ${m}`, meta),
      trace: (m, meta) => write("trace", `[${component}] ${m}`, meta),
      for: (c: string) => make(`${component}:${c}`),
      traceDir: () => traceDir,
    };
  }

  return make("deep-memory");
}

/** Dump a hook's input/output to the trace directory for post-mortem analysis. */
export function dumpTrace(
  logger: Logger,
  hookName: string,
  payload: { input?: unknown; output?: unknown },
): void {
  const dir = logger.traceDir();
  if (!dir) return;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `${hookName}-${stamp}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* swallow */
  }
}
