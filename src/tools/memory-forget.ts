/**
 * memory_forget tool — delete memory entries by content match.
 */

import { tool } from "@opencode-ai/plugin";
import type { SearchService } from "../search/service.js";

/**
 * Create the memory_forget tool bound to a SearchService instance.
 */
export function createMemoryForgetTool(service: SearchService) {
  return tool({
    description:
      "Delete a memory entry by content match. Without confirm=true, shows matches only.",
    args: {
      query: tool.schema.string().describe("Content to forget (BM25 match)"),
      scope: tool.schema
        .enum(["global", "project", "session", "all"])
        .default("project")
        .describe("Memory scope to search"),
      confirm: tool.schema
        .boolean()
        .default(false)
        .describe("Must be true to actually delete; false shows matches"),
    },
    async execute(args) {
      if (!args.confirm) {
        const results = await service.search(args.query, {
          scope: args.scope,
          limit: 10,
        });

        if (results.length === 0) {
          return `No matches found for "${args.query}"`;
        }

        const lines: string[] = [
          `Found ${results.length} match${results.length === 1 ? "" : "es"} (set confirm=true to delete):`,
        ];
        for (const r of results) {
          const label = r.heading
            ? `${r.scope}/${r.filePath.split("/").pop()}#${r.heading}`
            : `${r.scope}/${r.filePath.split("/").pop()}`;
          lines.push(`[score=${r.score.toFixed(2)}] ${label}`);
          if (r.snippet) {
            lines.push(`  ${r.snippet}`);
          }
        }
        return lines.join("\n");
      }

      const result = await service.removeEntry(
        args.scope === "all" ? "project" : args.scope,
        "memory",
        args.query,
      );

      if (result.removed === 0) {
        return `No matching entries found for "${args.query}"`;
      }

      return `Removed ${result.removed} matching ${result.removed === 1 ? "entry" : "entries"} for "${args.query}"`;
    },
  });
}
