/**
 * Re-exports from shared/ for ergonomic imports.
 *
 * Usage: `import { logger, memoryFilePath, estimateTokens, acquireLock } from "./shared";`
 */

export { createLogger, dumpTrace } from "./log.js";
export type { Logger, LogLevel } from "./log.js";

export {
  resolveDataRoot,
  hashProject,
  scopeDir,
  memoryFilePath,
  scheduleFilePath,
  indexStateFilePath,
  checkpointRawPath,
  sessionCheckpointDir,
} from "./paths.js";
export type { Scope, MemoryType } from "./paths.js";

export { estimateTokens, estimateTokensSum, truncateToTokenBudget } from "./tokens.js";

export { acquireLock, tryAcquireLock } from "./lock.js";
export type { LockInfo, LockOptions } from "./lock.js";
