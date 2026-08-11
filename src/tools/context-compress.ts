import { tool } from "@opencode-ai/plugin";
import type { PluginState } from "../hooks/shared-state.js";
import { buildCompressionPrompt } from "../compress/compression-prompt.js";

type OpencodeClient = {
  session: {
    messages: (args: { path: { id: string } }) => Promise<{ data?: unknown[] }>;
    create: (args: { body: { parentID: string; title: string }; query: { directory: string } }) => Promise<{ data?: { id?: string } }>;
    promptAsync: (args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }>; agent: string } }) => Promise<unknown>;
  };
  tui: {
    showToast: (args: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown>;
  };
};

export function createContextCompressTool(state: PluginState, client: unknown, projectPath: string) {
  const typedClient = client as OpencodeClient | undefined;
  return tool({
    description:
      "Compress older conversation context to reclaim token budget. " +
      "You can optionally provide a summary of what to remember; if omitted, a background subagent generates one.\n\n" +
      "WHEN to use: when the conversation is getting long and you're losing track of earlier context.\n" +
      "WHAT to include in summary (if provided): file paths, function signatures, key decisions, error messages and fixes, user-stated constraints.\n" +
      "WHAT to omit from summary: verbose tool output, failed attempts, routine operations — they'll be auto-compressed.",
    args: {
      summary: tool.schema
        .string()
        .optional()
        .describe("Brief (2-5 sentences) summary of the conversation content you want preserved. If omitted, a subagent generates the summary automatically."),
      keep_recent: tool.schema
        .number()
        .default(8)
        .describe("Number of recent messages to protect from compression (default 8)"),
    },
    async execute(args, context) {
      const keep = Math.max(2, Math.floor(args.keep_recent));

      if (args.summary) {
        state.requestContentAwareCompression({ keepRecent: keep, summary: args.summary });
        return {
          title: "Compression scheduled",
          output:
            `Will compress messages older than the last ${keep} on next turn. ` +
            `Tool outputs: bash/grep/glob → truncated head+tail; read of recently-edited files → marked outdated; ` +
            `other content → captured in your summary. Originals stored in CCR — call deep_expand("<hash>") to restore.`,
        };
      }

      if (!typedClient) {
        state.requestContentAwareCompression({ keepRecent: keep, summary: "" });
        return {
          title: "Compression scheduled (no subagent)",
          output: "Subagent unavailable. Empty summary compression will be applied on next turn.",
        };
      }

      const { sessionID } = context;

      let allMessages: unknown[] = [];
      try {
        const resp = await typedClient.session.messages({ path: { id: sessionID } });
        allMessages = resp.data ?? [];
      } catch {
        return { title: "Error", output: "Failed to fetch session messages for compression." };
      }

      const cutoff = allMessages.length - keep;
      if (cutoff <= 0) {
        return { title: "Nothing to compress", output: `Only ${allMessages.length} messages, nothing older than keep_recent=${keep}.` };
      }

      const toCompress = allMessages.slice(0, cutoff);

      let subID: string | undefined;
      try {
        const resp = await typedClient.session.create({
          body: {
            parentID: sessionID,
            title: `Context Compression ${new Date().toISOString().slice(0, 10)}`,
          },
          query: { directory: projectPath || context.directory },
        });
        subID = resp?.data?.id;
      } catch {
        return { title: "Error", output: "Failed to spawn compression subagent." };
      }

      if (!subID) {
        return { title: "Error", output: "Failed to spawn compression subagent (no session ID)." };
      }

      const prompt = buildCompressionPrompt(toCompress as never);
      try {
        await typedClient.session.promptAsync({
          path: { id: subID },
          body: { parts: [{ type: "text", text: prompt }], agent: "general" },
        });
      } catch {
        return { title: "Error", output: "Failed to prompt compression subagent." };
      }

      state.markSubSessionSpawned(subID);
      state.requestContentAwareCompression({
        keepRecent: keep,
        summary: "",
        subSessionID: subID,
      });

      typedClient.tui.showToast({
        body: {
          title: "deep-memory",
          message: "▣ deep-memory | context compression spawned (general)",
          variant: "info",
          duration: 3000,
        },
      }).catch(() => {});

      return {
        title: "Compression scheduled",
        output:
          `Subagent spawned to summarize ${cutoff} messages. ` +
          `Compression will apply automatically when the subagent completes (usually next turn).`,
      };
    },
  });
}
