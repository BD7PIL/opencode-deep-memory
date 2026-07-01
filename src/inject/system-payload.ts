/**
 * V4: Compose the system prompt payload — frozen TOOL_HINT + mtime-cached MEMORY.md.
 *
 * The payload is byte-stable across turns (unless MEMORY.md changes),
 * because 95%+ of turns hit the mtime cache. See DESIGN_V4.md D5.
 */

import fs from "node:fs";
import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import { memoryFilePath } from "../shared/paths.js";

export const TOOL_HINT =
  "Memory tools available: memory_search, memory_store, memory_forget.\n" +
  "Guidelines:\n" +
  "  (1) BEFORE making ANY technical decision, search: memory_search(query=\"decision OR decided OR chose\", scope=\"project\")\n" +
  "  (2) BEFORE fixing an error, search for known pitfalls: memory_search(query=\"gotcha OR error OR bug\", scope=\"project\")\n" +
  "  (3) AFTER fixing an error, store it: memory_store(type=\"gotcha\", content=\"[error]: ... → [fix]: ...\", scope=\"project\")\n" +
  "  (4) WHEN user states a constraint/rule, store it: memory_store(type=\"constraint\", content=\"...\", scope=\"project\")\n" +
  "  (5) WHEN a technical decision is made, store it: memory_store(type=\"decision\", content=\"[decision]: ... → [reason]: ...\", scope=\"project\")";

export interface ComposeSystemPayloadOpts {
  state: PluginState;
  sessionID?: string;
  projectPath: string;
  logger?: Logger;
}

export interface ComposeSystemPayloadResult {
  payload: string;
  cacheHit: boolean;
  memorySize: number;
}

export async function composeSystemPayload(
  opts: ComposeSystemPayloadOpts,
): Promise<ComposeSystemPayloadResult> {
  const { state, projectPath, logger } = opts;

  const memoryPath = memoryFilePath("project", "memory", projectPath);
  let memoryContent = "";
  let cacheHit = true;

  try {
    const stat = fs.statSync(memoryPath);
    const mtime = stat.mtimeMs;

    if (state.isMemoryCacheFresh(mtime)) {
      memoryContent = state.getMemoryCache()?.content ?? "";
      cacheHit = true;
    } else {
      memoryContent = fs.readFileSync(memoryPath, "utf8");
      state.setMemoryCache(memoryContent, mtime);
      cacheHit = false;
    }
  } catch {
    state.clearMemoryCache();
    cacheHit = false;
  }

  const memorySize = memoryContent.length;
  let payload = `<deep-memory-stable>\n<tool-hint>\n${TOOL_HINT}\n</tool-hint>`;
  if (memoryContent.trim().length > 0) {
    payload += `\n<constraints>\n${memoryContent}\n</constraints>`;
  }
  payload += `\n</deep-memory-stable>`;

  logger?.debug("composeSystemPayload V4", { cacheHit, memorySize });

  return { payload, cacheHit, memorySize };
}
