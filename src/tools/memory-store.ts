/**
 * memory_store tool — store a memory entry (decision, constraint, gotcha, fact, note).
 */

import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import nodePath from "node:path";
import type { SearchService } from "../search/service.js";
import { memoryFilePath } from "../shared/paths.js";
import { findNearDuplicate } from "../extract/consolidate.js";
import { extractEntities } from "../shared/entity-extract.js";

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
export function createMemoryStoreTool(service: SearchService, state?: { incrementMemoryStoreCount: () => void }) {
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
      // Defensive defaults: zod .default() may not apply in real opencode calls
      const type = args.type ?? "note";
      const scope = args.scope ?? "project";
      const sectionMap: Record<string, string> = {
        decision: "Decisions",
        constraint: "Constraints",
        gotcha: "Gotchas",
        fact: "Facts",
        note: "Notes",
      };
      const section = sectionMap[type] ?? "Notes";
      const today = new Date().toISOString().slice(0, 10);
      const contentWithDate = `${args.content} [${today}]`;

      // D1: cap check before addEntry — overflow goes to archive only
      const memoryPath = memoryFilePath(scope, "memory", service.project);
      const { lines, bytes } = await checkOverflow(memoryPath);
      if (lines >= MEMORY_MAX_LINES || bytes >= MEMORY_MAX_BYTES) {
        await archiveEntry(memoryPath, `- ${contentWithDate}`);
        return `MEMORY.md at cap (${lines} lines/${bytes} bytes). Entry archived to MEMORY-archive.md. Use memory_search on MEMORY.md content; archived entries are available for manual review.`;
      }

      // G8 (A-Mem): write-time dedup — reject near-duplicate before storing
      const existingContent = fs.existsSync(memoryPath)
        ? await fs.promises.readFile(memoryPath, "utf8")
        : "";
      const newLine = `- ${contentWithDate}`;
      const dup = findNearDuplicate(newLine, existingContent);
      if (dup) {
        return `Near-duplicate detected (similarity ${(dup.similarity * 100).toFixed(0)}%).\nExisting: "${dup.existingLine.slice(0, 100)}..."\nNot stored. Use memory_forget to remove the old entry first if it should be replaced.`;
      }

      // Claude Code pattern: warn at 90% cap
      if (lines >= MEMORY_MAX_LINES * 0.9 || bytes >= MEMORY_MAX_BYTES * 0.9) {
        await service.addEntry(scope, "memory", section, contentWithDate);
        state?.incrementMemoryStoreCount();
        return `WARNING: MEMORY.md at 90% cap (${lines}/${MEMORY_MAX_LINES} lines, ${bytes}/${MEMORY_MAX_BYTES} bytes).\nStored, but consolidation recommended soon. Run /checkpoint or wait for idle consolidation.`;
      }

      await service.addEntry(scope, "memory", section, contentWithDate);
      state?.incrementMemoryStoreCount();

      // G2 (Mem0): extract entities and write to sidecar for boosted search
      try {
        const entities = extractEntities(args.content);
        if (entities.length > 0) {
          const sidecarPath = nodePath.join(nodePath.dirname(memoryPath), ".entities.json");
          let existing: Array<{ section: string; entities: string[] }> = [];
          if (fs.existsSync(sidecarPath)) {
            existing = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          }
          existing.push({ section, entities });
          fs.writeFileSync(sidecarPath, JSON.stringify(existing), "utf8");
        }
      } catch {
        // Entity sidecar is best-effort — don't fail the store
      }

      return `Stored ${type} in ${scope} memory under ## ${section}`;
    },
  });
}
