/**
 * memory_search tool — search persistent memory across sessions.
 */

import { tool } from "@opencode-ai/plugin";
import type { SearchService } from "../search/service.js";

/**
 * Create the memory_search tool bound to a SearchService instance.
 */
export function createMemorySearchTool(service: SearchService) {
  return tool({
    description:
      "Search persistent memory (decisions, constraints, notes from past sessions). Supports Chinese phrases.",
    args: {
      query: tool.schema
        .string()
        .describe("Search query (supports Chinese phrases and OR with |)"),
      scope: tool.schema
        .enum(["global", "project", "session", "all"])
        .default("all")
        .describe("Memory scope to search"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of results (1-20)"),
    },
    async execute(args) {
      const results = await service.search(args.query, {
        scope: args.scope,
        limit: args.limit,
      });

      if (results.length === 0) {
        return `No matches found for "${args.query}"`;
      }

      const lines: string[] = [
        `Found ${results.length} match${results.length === 1 ? "" : "es"} (showing top ${results.length}):`,
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
    },
  });
}
