/**
 * memory_expand tool — retrieve original (unstripped) content from checkpoint.raw.json.
 *
 * When the memory plugin compresses context, old messages get stripped.
 * This tool lets the agent "zoom in" on compressed content by reading the
 * raw checkpoint dump that preserves the original message parts.
 */

import { z } from "zod";
import { checkpointRawPath } from "../shared/paths.js";
import fs from "node:fs";

export function createMemoryExpandTool(opts: { projectPath: string }) {
  return {
    description:
      "Expand compressed context — retrieve original content of a message that was stripped by the memory plugin's context compression. Use when you need to see the full reasoning, tool output, or text of an old message that was compressed.",
    args: z.object({
      messageID: z
        .string()
        .describe("The message ID to expand (visible in conversation history)"),
    }).shape,
    execute: async (args: { messageID: string }): Promise<string> => {
      // 1. Find checkpoint.raw.json
      const rawPath = checkpointRawPath(opts.projectPath, ""); // sessionID not used in path
      if (!fs.existsSync(rawPath)) {
        return "No checkpoint.raw.json found. No compressed messages to expand.";
      }
      // 2. Read and parse
      try {
        const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
        const messages = raw.messages || [];
        // 3. Find message by ID
        const msg = messages.find(
          (m: { info?: { id?: string } }) => m.info?.id === args.messageID,
        );
        if (!msg) {
          return `Message ${args.messageID} not found in checkpoint. Available: ${messages.length} messages.`;
        }
        // 4. Format and return
        return formatExpandedMessage(msg);
      } catch (e) {
        return `Error reading checkpoint: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

export function formatExpandedMessage(msg: {
  info?: { id?: string; role?: string; time?: { created?: number } };
  parts?: Array<{
    type: string;
    text?: string;
    thinking?: string;
    tool?: string;
    state?: { status?: string; error?: string; output?: unknown };
  }>;
}): string {
  let output = `=== Expanded Message ${msg.info?.id ?? "?"} ===\n`;
  output += `Role: ${msg.info?.role ?? "unknown"}\n`;
  output += `Time: ${msg.info?.time?.created ? new Date(msg.info.time.created).toISOString() : "unknown"}\n\n`;

  for (const part of msg.parts || []) {
    if (part.type === "text" && part.text) {
      output += `[TEXT]\n${part.text}\n\n`;
    } else if (part.type === "reasoning" || part.type === "thinking") {
      output += `[REASONING]\n${part.thinking || part.text || "[empty]"}\n\n`;
    } else if (part.type === "tool") {
      output += `[TOOL: ${part.tool ?? "unknown"}]\n`;
      if (part.state?.status) output += `Status: ${part.state.status}\n`;
      if (part.state?.error) output += `Error: ${part.state.error}\n`;
      if (part.state?.output) {
        const outputStr =
          typeof part.state.output === "string"
            ? part.state.output
            : JSON.stringify(part.state.output);
        output += `Output: ${outputStr.slice(0, 500)}...\n`;
      }
      output += "\n";
    }
  }

  return output;
}
