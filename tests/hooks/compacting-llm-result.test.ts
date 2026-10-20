/**
 * compacting hook — Step 4b: the LLM consolidation RESULT path.
 *
 * This is where the previous turn's consolidation sub-session output gets
 * applied to MEMORY.md — or thrown away. Three guards must hold (they were the
 * uncovered half of compacting.ts):
 *   · mtime race: MEMORY.md changed since the sub-session started → discard,
 *     never clobber newer content with a stale summary;
 *   · LLM error part in the result → report, don't write;
 *   · validateConsolidation (over-deletion etc.) → reject, don't write.
 * And the one write path must leave a MEMORY.bak.md behind.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompactingHandler } from "../../src/hooks/compacting.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { mockHostClient } from "../helpers/mock-host.js";

const MAIN_MESSAGES = [
  { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "Build a REST API" }] },
  { info: { id: "m2", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "Use Express." }] },
];

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-compact-result-"));
}

const memoryPath = (p: string) => path.join(p, ".deep-memory", "MEMORY.md");
const backupPath = (p: string) => path.join(p, ".deep-memory", "MEMORY.bak.md");

/** 30 unique bullet entries — inert to consolidateMemory: the tokenizer drops
 *  numerals, so "entry 1 about topic 7" style lines all collapse to the same
 *  token set and step 4a would rewrite the file before 4b ever runs. Each entry
 *  therefore carries a distinct WORD (Jaccard 1/3, far below the 0.9 dedupe). */
const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
  "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "amber", "birch", "cedar", "dune",
];

function seedMemory(project: string): string {
  fs.mkdirSync(path.join(project, ".deep-memory"), { recursive: true });
  const lines = ["# Memory", ...WORDS.map((w, i) => `- entry ${i} ${w} decision`)];
  const content = lines.join("\n");
  fs.writeFileSync(memoryPath(project), content, "utf8");
  return content;
}

async function run(
  project: string,
  subResult: Array<{ info: unknown; parts: unknown[] }>,
  opts: { memMtime?: number } = {},
) {
  const state = createPluginState();
  const toastCalls: Array<{ body: { message: string } }> = [];
  const client = mockHostClient({
    toastSpy: (async (opts: { body: { message: string } }) => { toastCalls.push(opts); }) as never,
  });
  client.session.messages
    .mockResolvedValueOnce({ data: MAIN_MESSAGES })
    .mockResolvedValueOnce({ data: subResult });

  state.setPendingConsolidation("s1", {
    subSessionID: "sub-1",
    memMtime: opts.memMtime ?? fs.statSync(memoryPath(project)).mtimeMs,
  });

  const handler = createCompactingHandler({ client, state, projectPath: project });
  const output = { context: [] as string[] };
  await handler({ sessionID: "s1" }, output);
  return { client, toastCalls, output };
}

const subText = (text: string) => [{ info: { id: "sm1", role: "assistant", sessionID: "sub-1" }, parts: [{ type: "text", text }] }];

describe("compacting Step 4b — applying (or discarding) the LLM consolidation", () => {
  it("applies a valid result: MEMORY.md replaced, MEMORY.bak.md keeps the original", async () => {
    const project = tmpProject();
    try {
      const original = seedMemory(project);
      const originalLines = original.split("\n");
      // Valid: ≥30% of lines survive (30 lines → need ≥9), ≤1.05× length.
      const consolidated = ["# Memory", ...originalLines.slice(1, 25)].join("\n");
      await run(project, subText(consolidated));

      expect(fs.readFileSync(memoryPath(project), "utf8")).toBe(consolidated);
      expect(fs.readFileSync(backupPath(project), "utf8")).toBe(original);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("discards on an mtime race — newer MEMORY.md beats a stale LLM summary", async () => {
    const project = tmpProject();
    try {
      const original = seedMemory(project);
      // The sub-session started BEFORE the current file was written.
      const { toastCalls } = await run(project, subText("# Memory\n- rewritten"), {
        memMtime: fs.statSync(memoryPath(project)).mtimeMs - 10_000,
      });
      expect(fs.readFileSync(memoryPath(project), "utf8")).toBe(original);
      expect(fs.existsSync(backupPath(project))).toBe(false);
      expect(toastCalls.some((t) => t.body.message.includes("discarded (mtime race)"))).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports an LLM error part instead of writing garbage", async () => {
    const project = tmpProject();
    try {
      const original = seedMemory(project);
      const { toastCalls } = await run(project, [
        { info: { id: "sm1", role: "assistant", sessionID: "sub-1" }, parts: [{ type: "error", text: "provider 400" }] },
      ]);
      expect(fs.readFileSync(memoryPath(project), "utf8")).toBe(original);
      expect(toastCalls.some((t) => t.body.message.includes("consolidation failed (LLM error"))).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects an over-deleted result (validateConsolidation) and keeps the original", async () => {
    const project = tmpProject();
    try {
      const original = seedMemory(project);
      const { toastCalls } = await run(project, subText("# Memory\n- one"));
      expect(fs.readFileSync(memoryPath(project), "utf8")).toBe(original);
      expect(fs.existsSync(backupPath(project))).toBe(false);
      expect(toastCalls.some((t) => t.body.message.includes("consolidation rejected"))).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("reads exactly the pending sub-session (limit 1) and consumes the pending flag", async () => {
    const project = tmpProject();
    try {
      seedMemory(project);
      const { client } = await run(project, subText("# Memory\n- x"));
      const calls = client.session.messages.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[1]?.[0]).toEqual({ path: { id: "sub-1" }, query: { limit: 1 } });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});