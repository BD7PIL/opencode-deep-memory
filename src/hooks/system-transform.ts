/**
 * experimental.chat.system.transform hook handler.
 *
 * Injects memory context into the system prompt based on agent tier
 * and resume state. This is the core of the adaptive injection pillar.
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";
import type { SearchService } from "../search/service.js";
import { composeSystemPayload } from "../inject/system-payload.js";
import { classifyAgent } from "../inject/agent-budget.js";

/**
 * Create a system.transform handler for adaptive memory injection.
 */
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

    let mode: "normal" | "post-compaction" | "post-resume" = "normal";

    if (state.hasPendingResume(sessionID)) {
      const agent = state.agentOf(sessionID);
      const tier = classifyAgent(agent);
      if (tier === "main") {
        mode = "post-resume";
        state.consumePendingResume(sessionID);
      }
    }

    const userQuery = state.consumeLastUserText(sessionID);

    const payload = await composeSystemPayload({
      state,
      sessionID,
      projectPath,
      mode,
      searchService,
      userQuery,
      logger,
    });

    if (payload) {
      output.system.push(payload);
    }

    const agent = state.agentOf(sessionID);
    const tier = classifyAgent(agent);
    logger?.debug("system.transform: injected", {
      sessionID,
      agent: agent ?? "(undefined)",
      tier,
      mode,
      payloadSize: payload.length,
    });
  };
}
