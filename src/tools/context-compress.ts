import { tool } from "@opencode-ai/plugin";
import type { PluginState } from "../hooks/shared-state.js";

export function createContextCompressTool(state: PluginState) {
  return tool({
    description:
      "Compress older conversation context to reclaim token budget. " +
      "Triggers compression of old tool outputs on the next turn — originals recoverable via deep_expand. " +
      "Use when the conversation feels long or you're losing track of early context.",
    args: {
      keep_recent: tool.schema
        .number()
        .default(8)
        .describe("Number of recent messages to protect from compression (default 8)"),
    },
    async execute(args) {
      const keep = Math.max(2, Math.floor(args.keep_recent));
      state.requestCompression(keep);
      return {
        title: "Compression requested",
        output:
          `Will compress tool outputs older than the last ${keep} messages on the next turn. ` +
          `Protected: memory_*, edit, write, todowrite, skill. ` +
          `Originals stored in CCR — call deep_expand("<hash>") to restore any compressed content.`,
      };
    },
  });
}
