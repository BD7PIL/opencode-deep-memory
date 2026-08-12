/**
 * memory_topic tool — read/write topic detail files (G1 Claude Code pattern).
 *
 * MEMORY.md entries can reference topic files via [topic:name] markers.
 * The agent uses this tool to read the full detail on demand.
 * Topic files are indexed by BM25 just like MEMORY.md (Reconciler scans topics/).
 */
import { tool } from "@opencode-ai/plugin";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { projectMemoryDir } from "../shared/paths.js";

export function createMemoryTopicTool(projectPath: string) {
  return tool({
    description:
      "Read or write a topic detail file. Use when MEMORY.md has an entry " +
      'referencing [topic:name] and you need the full detail. ' +
      "Also use to create new topic files when storing detailed knowledge " +
      "that is too long for a one-line MEMORY.md entry.",
    args: {
      name: tool.schema
        .string()
        .describe('Topic name (kebab-case, e.g. "granian-migration")'),
      action: tool.schema
        .enum(["read", "write", "list"])
        .default("read")
        .describe("Action: read existing topic, write new/update topic, or list all topics"),
      content: tool.schema
        .string()
        .optional()
        .describe("Content to write (required for action=write)"),
    },
    async execute(args) {
      const topicsDir = path.join(projectMemoryDir(projectPath), "topics");

      if (args.action === "list") {
        try {
          const entries = await readdir(topicsDir);
          const topics = entries
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.replace(/\.md$/, ""));
          if (topics.length === 0) return "No topic files found.";
          return `Topic files (${topics.length}):\n${topics.map((t) => `- ${t}`).join("\n")}`;
        } catch {
          return "No topics directory yet. Use action=write to create one.";
        }
      }

      if (args.action === "read") {
        const filePath = path.join(topicsDir, `${args.name}.md`);
        try {
          const content = await readFile(filePath, "utf8");
          return content;
        } catch {
          return `Topic "${args.name}" not found. Available topics: use action=list to see all.`;
        }
      }

      if (args.action === "write") {
        if (!args.content) {
          return "Error: content is required for action=write.";
        }
        await mkdir(topicsDir, { recursive: true });
        const filePath = path.join(topicsDir, `${args.name}.md`);
        await writeFile(filePath, args.content, "utf8");
        return `Topic "${args.name}" saved (${args.content.length} chars). ` +
          `Reference in MEMORY.md as: [topic:${args.name}]`;
      }

      return `Unknown action: ${args.action}`;
    },
  });
}
