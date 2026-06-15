/**
 * experimental.chat.system.transform hook handler.
 *
 * Injects memory context into the system prompt based on agent tier
 * and resume state. This is the core of the adaptive injection pillar.
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";
import { composeSystemPayload } from "../inject/system-payload.js";
import { classifyAgent } from "../inject/agent-budget.js";

/**
 * Create a system.transform handler for adaptive memory injection.
 */
export function createSystemTransformHandler(
  state: PluginState,
  projectPath: string,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (input, output) => {
    // 1. If no sessionID, skip (can't determine agent/state)
    if (!input.sessionID) {
      logger?.debug("system.transform: no sessionID, skipping");
      return;
    }

    const sessionID = input.sessionID;

    // 2. Determine mode
    let mode: "normal" | "post-compaction" | "post-resume" = "normal";

    if (state.hasPendingResume(sessionID)) {
      const agent = state.agentOf(sessionID);
      const tier = classifyAgent(agent);
      if (tier === "main") {
        mode = "post-resume";
        // Consume the flag — only first call gets post-resume budget
        state.consumePendingResume(sessionID);
      }
    }

    // 3. Compose payload
    const payload = composeSystemPayload({
      state,
      sessionID,
      projectPath,
      mode,
      logger,
    });

    // 4. Push to output if non-empty
    if (payload) {
      output.system.push(payload);
    }

    // 5. Log
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
