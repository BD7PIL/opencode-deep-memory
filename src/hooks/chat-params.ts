import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";

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
