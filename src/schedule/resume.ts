/**
 * Resume detection for session continuity.
 *
 * When a new session is created, check if the project has a MEMORY.md.
 * If so, set a pending resume flag so the first system.transform call
 * uses the expanded post-resume budget (3000t for main agents).
 */

import fs from "node:fs";
import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import { memoryFilePath, hashProject } from "../shared/paths.js";

export interface SessionCreatedEvent {
  type: "session.created";
  properties: {
    info: {
      id: string;
      parentID?: string;
      directory: string;
      title: string;
    };
  };
}

export interface HandleSessionCreatedArgs {
  state: PluginState;
  event: SessionCreatedEvent;
  projectPath: string;
  logger?: Logger;
}

/**
 * Handle a session.created event for resume detection.
 *
 * Flow:
 * 1. Skip if parentID is set (sub-sessions don't trigger resume)
 * 2. Skip if title starts with "Memory " (our own background sessions)
 * 3. Resolve projectHash from projectPath
 * 4. Check if MEMORY.md exists
 * 5. If exists: set pending resume flag with 3000t budget
 */
export async function handleSessionCreated(
  args: HandleSessionCreatedArgs,
): Promise<void> {
  const { state, event, projectPath, logger } = args;
  const info = event.properties.info;
  const sessionID = info.id;

  // 1. Skip sub-sessions
  if (info.parentID) {
    logger?.debug("resume: skipping sub-session", {
      sessionID,
      parentID: info.parentID,
    });
    return;
  }

  // 2. Skip our own background sessions
  if (info.title.startsWith("Memory ")) {
    logger?.debug("resume: skipping Memory-* session", {
      sessionID,
      title: info.title,
    });
    return;
  }

  // 3. Resolve project hash
  const projectHash = hashProject(projectPath);

  // 4. Check if MEMORY.md exists
  const memoryPath = memoryFilePath("project", "memory", projectPath);
  let memoryExists = false;
  let memorySize = 0;
  try {
    const stat = fs.statSync(memoryPath);
    memoryExists = stat.isFile();
    memorySize = stat.size;
  } catch {
    memoryExists = false;
  }

  if (!memoryExists) {
    logger?.debug("resume: no MEMORY.md found, skipping", {
      sessionID,
      projectHash,
    });
    return;
  }

  // 5. Set pending resume
  const wasSet = state.setPendingResume(sessionID, {
    budgetTokens: 3000,
    projectHash,
  });

  if (wasSet) {
    logger?.info(
      `Resume detected for session ${sessionID}, project ${projectHash}, MEMORY.md size ${memorySize}`,
    );
  }
}
