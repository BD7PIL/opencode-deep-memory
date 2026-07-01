/**
 * experimental.chat.system.transform hook handler.
 *
 * V4: Injects frozen TOOL_HINT + mtime-cached MEMORY.md only.
 * No volatile block, no BM25 search, no repomap. See DESIGN_V4.md.
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";
import type { SearchService } from "../search/service.js";
import { composeSystemPayload } from "../inject/system-payload.js";
import { shouldWhisper, formatWhisper } from "../inject/auto-search.js";

export function createSystemTransformHandler(
  state: PluginState,
  projectPath: string,
  searchService?: SearchService,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (input, output) => {
    if (!input.sessionID) {
      logger?.debug("system.transform: no sessionID, skipping");
      return;
    }

    const sessionID = input.sessionID;
    const userQuery = state.consumeLastUserText(sessionID);

    const { payload, cacheHit, memorySize } = await composeSystemPayload({
      state,
      sessionID,
      projectPath,
      logger,
    });

    let finalPayload = payload;

    if (!state.hasGreetedSession(sessionID)) {
      state.markGreetedSession(sessionID);
      if (searchService && userQuery) {
        try {
          await searchService.ensureIndex();
          const results = await searchService.search(userQuery, { scope: "all", limit: 10 });
          if (shouldWhisper(results)) {
            finalPayload += `\n${formatWhisper(results, userQuery)}`;
          }
        } catch {
          // search failure is non-fatal
        }
      }
    }

    output.system.push(finalPayload);

    logger?.debug("system.transform V4: injected", {
      sessionID,
      cacheHit,
      memorySize,
      payloadSize: finalPayload.length,
    });

    state.mergeNotify({
      injection: {
        stableSize: finalPayload.length,
        volatileSize: 0,
        tier: "v4",
        mode: "normal",
        searchEntries: 0,
        repoMapEntries: 0,
        hasCheckpoint: false,
      },
    });
  };
}
