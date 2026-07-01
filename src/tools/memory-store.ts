/**
 * memory_store tool — store a memory entry (decision, constraint, gotcha, fact, note).
 */

import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import nodePath from "node:path";
import type { SearchService } from "../search/service.js";
import { memoryFilePath } from "../shared/paths.js";

const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25_000;

async function checkOverflow(filePath: string): Promise<{ lines: number; bytes: number }> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    return { lines: content.split("\n").length, bytes: content.length };
  } catch {
    return { lines: 0, bytes: 0 };
  }
}

async function archiveEntry(filePath: string, entry: string): Promise<void> {
  const archivePath = filePath.replace("MEMORY.md", "MEMORY-archive.md");
  await fs.promises.mkdir(nodePath.dirname(archivePath), { recursive: true });
  await fs.promises.appendFile(archivePath, `\n${entry}\n`, "utf8");
}

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

      // D1: cap check before addEntry — overflow goes to archive only
      const memoryPath = memoryFilePath(args.scope, "memory", service.project);
      const { lines, bytes } = await checkOverflow(memoryPath);
      if (lines >= MEMORY_MAX_LINES || bytes >= MEMORY_MAX_BYTES) {
        await archiveEntry(memoryPath, `- ${contentWithDate}`);
        return `MEMORY.md at cap (${lines} lines/${bytes} bytes). Entry archived to MEMORY-archive.md. Use memory_search on MEMORY.md content; archived entries are available for manual review.`;
      }

      await service.addEntry(args.scope, "memory", section, contentWithDate);

      return `Stored ${args.type} in ${args.scope} memory under ## ${section}`;
    },
  });
}
