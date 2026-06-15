/**
 * chat.message hook — keyword detection for notes.md capture.
 *
 * Inspects user messages for "remember / don't forget / note:" style keywords
 * (English and Chinese) and appends matching messages to the project's notes.md.
 *
 * Uses post-write deduplication: after appending, scans for duplicate hash
 * entries and removes them. This is immune to concurrent plugin instances.
 *
 * Only captures user text parts. Assistant messages are skipped (captured in checkpoint).
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Hooks } from "@opencode-ai/plugin";
import { memoryFilePath, acquireLock } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import type { PluginState } from "./shared-state.js";

export interface ChatMessageConfig {
  projectPath: string;
  state: PluginState;
  logger?: Logger;
}

const MAX_NOTE_LENGTH = 500;

const KEYWORDS = [
  "remember",
  "don't forget",
  "note:",
  "important:",
  "constraint:",
  "must not",
  "never do",
  "记住",
  "别忘",
  "注意：",
  "重要：",
  "约束：",
  "绝不能",
  "必须",
];

function matchesKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + " [truncated]";
}

function deduplicateEntries(content: string): string {
  const seenHashes = new Set<string>();
  const blocks = content.split(/\n(?=## )/);
  const kept: string[] = [];
  for (const block of blocks) {
    const match = block.match(/\[([a-f0-9]{8})\]/);
    if (match) {
      const hash = match[1];
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
    }
    kept.push(block);
  }
  return kept.join("\n");
}

export function createChatMessageHandler(
  config: ChatMessageConfig,
): NonNullable<Hooks["chat.message"]> {
  const { projectPath, state, logger } = config;

  return async (input, output) => {
    if (output.message.role !== "user") return;
    if (input.agent) return;

    const textParts = output.parts.filter(
      (p): p is Extract<(typeof output.parts)[number], { type: "text" }> =>
        p.type === "text",
    );
    if (textParts.length === 0) return;

    const fullText = textParts.map((p) => p.text).join("");
    state.recordLastUserText(input.sessionID, fullText);

    if (!matchesKeyword(fullText)) return;

    const truncated = truncate(fullText, MAX_NOTE_LENGTH);
    const contentHash = createHash("md5").update(truncated).digest("hex").slice(0, 8);

    const notesFile = memoryFilePath("project", "notes", projectPath);
    const sid8 = input.sessionID.slice(0, 8);
    const timestamp = new Date().toISOString();

    try {
      await mkdir(path.dirname(notesFile), { recursive: true });
      const release = await acquireLock(notesFile);
      try {
        let content = await readFile(notesFile, "utf8").catch(() => "");
        if (content.includes(`[${contentHash}]`)) {
          logger?.debug("notes: skipped duplicate", { hash: contentHash });
          return;
        }
        const entry = `\n## ${timestamp} (session ${sid8}) [${contentHash}]\n${truncated}\n`;
        content = deduplicateEntries(content + entry);
        await writeFile(notesFile, content, "utf8");
      } finally {
        release();
      }
      logger?.debug("notes: captured keyword match", {
        sessionID: input.sessionID,
        hash: contentHash,
      });
    } catch (err) {
      logger?.warn("notes: failed to write notes.md", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
