/**
 * Checkpoint writer — renders heuristic results to Markdown and writes to disk.
 *
 * Produces the checkpoint.md file that survives compaction.
 * Template skips empty sections (except User Intent which always shows).
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../shared/log.js";
import type { HeuristicResult } from "./heuristics.js";
import { memoryFilePath } from "../shared/paths.js";
import { acquireLock } from "../shared/lock.js";

export interface RenderArgs {
  sessionID: string;
  tokenEstimate: number;
  result: HeuristicResult;
}

/**
 * Render a HeuristicResult to a Markdown checkpoint document.
 *
 * Sections are omitted when empty, except User Intent which shows
 * _(none captured)_ when there are no entries.
 */
export function renderCheckpoint(args: RenderArgs): string {
  const { sessionID, tokenEstimate, result } = args;
  const lines: string[] = [];

  lines.push(`# Checkpoint — ${sessionID}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Session token estimate: ${tokenEstimate}`);
  lines.push("");

  // User Intent — always present
  lines.push("## User Intent");
  if (result.userIntents.length > 0) {
    for (const intent of result.userIntents) {
      lines.push(`- ${intent}`);
    }
  } else {
    lines.push("_(none captured)_");
  }
  lines.push("");

  // Decisions — skip if empty
  if (result.decisions.length > 0) {
    lines.push("## Decisions");
    for (const d of result.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // Constraints — skip if empty
  if (result.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of result.constraints) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Gotchas — skip if empty
  if (result.gotchas.length > 0) {
    lines.push("## Gotchas");
    for (const g of result.gotchas) {
      lines.push(`- Error: ${g.error} → Fix: ${g.fix}`);
    }
    lines.push("");
  }

  // File Changes — skip if empty
  if (result.fileChanges.length > 0) {
    lines.push("## File Changes");
    for (const fc of result.fileChanges) {
      lines.push(`- ${fc.path}: ${fc.operation}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface WriteCheckpointArgs {
  projectPath: string;
  sessionID: string;
  content: string;
  logger?: Logger;
}

/**
 * Write checkpoint content to the project-scoped checkpoint.md file.
 *
 * Uses file locking to coordinate with concurrent sessions.
 * Returns the absolute path of the written file.
 */
export async function writeCheckpoint(args: WriteCheckpointArgs): Promise<string> {
  const { projectPath, content, logger } = args;

  const filePath = memoryFilePath("project", "checkpoint", projectPath);

  // Ensure directory exists
  await mkdir(path.dirname(filePath), { recursive: true });

  const release = await acquireLock(filePath);
  try {
    await writeFile(filePath, content, "utf-8");
  } finally {
    release();
  }

  logger?.debug("writeCheckpoint: wrote checkpoint", { filePath });
  return filePath;
}
