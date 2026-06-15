/**
 * chat.params hook handler.
 *
 * Records the sessionID → agent mapping so that system.transform
 * can look up the agent for adaptive budget selection.
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";

/**
 * Create a chat.params handler that records agent mappings.
 */
export function createChatParamsHandler(
  state: PluginState,
  logger?: Logger,
): NonNullable<Hooks["chat.params"]> {
  return async (input, _output) => {
    state.recordAgent(input.sessionID, input.agent);
    state.recordModel(input.sessionID, {
      providerID: input.model.providerID,
      modelID: input.model.id,
    });
    logger?.debug("chat.params: recorded agent+model", {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model.id,
    });
  };
}
