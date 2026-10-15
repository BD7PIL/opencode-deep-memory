/**
 * Re-exports from shared/ for ergonomic imports (only the symbols src/ actually
 * pulls through the barrel — everything else imports its module directly).
 */

export { createLogger } from "./log.js";
export type { Logger, LogLevel } from "./log.js";

export { resolveDataRoot } from "./paths.js";
export type { Scope, MemoryType } from "./paths.js";

export { acquireLock } from "./lock.js";
export type { LockInfo, LockOptions } from "./lock.js";
