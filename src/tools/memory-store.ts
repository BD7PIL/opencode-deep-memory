/**
 * memory_store tool — store a memory entry (decision, constraint, gotcha, fact, note).
 */

import { tool } from "@opencode-ai/plugin";
import type { SearchService } from "../search/service.js";

/**
 * Create the memory_store tool bound to a SearchService instance.
 */
export function createMemoryStoreTool(service: SearchService) {
  return tool({
    description:
      "Store a memory entry (decision, constraint, gotcha, fact, note) to persistent memory.",
    args: {
      content: tool.schema.string().describe("Memory content (Markdown)"),
      type: tool.schema
        .enum(["decision", "constraint", "gotcha", "fact", "note"])
        .default("note")
        .describe("Type of memory entry"),
      scope: tool.schema
        .enum(["global", "project"])
        .default("project")
        .describe("Memory scope (global or project)"),
    },
    async execute(args) {
      const sectionMap: Record<string, string> = {
        decision: "Decisions",
        constraint: "Constraints",
        gotcha: "Gotchas",
        fact: "Facts",
        note: "Notes",
      };
      const section = sectionMap[args.type] ?? "Notes";
      const today = new Date().toISOString().slice(0, 10);
      const contentWithDate = `${args.content} [${today}]`;

      await service.addEntry(args.scope, "memory", section, contentWithDate);

      return `Stored ${args.type} in ${args.scope} memory under ## ${section}`;
    },
  });
}
