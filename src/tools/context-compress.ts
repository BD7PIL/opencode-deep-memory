import { tool } from "@opencode-ai/plugin";
import type { PluginState } from "../hooks/shared-state.js";

export function createContextCompressTool(state: PluginState) {
  return tool({
    description:
      "Compress older conversation context to reclaim token budget. " +
      "You provide a brief summary of what you want to remember from the old conversation; " +
      "the plugin compresses tool outputs and replaces old messages with your summary.\n\n" +
      "WHEN to use: when the conversation is getting long and you're losing track of earlier context.\n" +
      "WHAT to include in summary: file paths, function signatures, key decisions, error messages and fixes, user-stated constraints.\n" +
      "WHAT to omit from summary: verbose tool output, failed attempts, routine operations — they'll be auto-compressed.",
    args: {
      summary: tool.schema
        .string()
        .describe("Brief (2-5 sentences) summary of the conversation content you want preserved"),
      keep_recent: tool.schema
        .number()
        .default(8)
        .describe("Number of recent messages to protect from compression (default 8)"),
    },
    async execute(args) {
      const keep = Math.max(2, Math.floor(args.keep_recent));
      state.requestContentAwareCompression({
        keepRecent: keep,
        summary: args.summary,
      });
      return {
        title: "Compression scheduled",
        output:
          `Will compress messages older than the last ${keep} on next turn. ` +
          `Tool outputs: bash/grep/glob → truncated head+tail; read of recently-edited files → marked outdated; ` +
          `other content → captured in your summary. Originals stored in CCR — call deep_expand("<hash>") to restore.`,
      };
    },
  });
}
