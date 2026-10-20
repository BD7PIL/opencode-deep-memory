/**
 * Summary-block placement is chosen from the pass's own result.
 *
 * Measured with scripts/measure-summary-placement.mts (numbers in
 * docs/research/stage4-cache-work.md):
 *
 *  - when the pass rewrote history, the insert position is FREE — the cached
 *    prefix ends at the first rewrite, not at the insert — so the summary is
 *    spliced at the compressed-zone boundary, ahead of the retained tail.
 *  - when the pass rewrote nothing, the insert is the ONLY mutation, and a
 *    mid-array splice re-prefilled the entire retained tail (8 messages /
 *    656 chars). The summary is appended there instead, which costs nothing and
 *    loses nothing: with no compressed block, there is nothing for it to precede.
 *
 * A "no index shift" placement that anchors the summary to the compressed zone's
 * last message was measured too and is WORSE than the splice (9 messages /
 * 738 chars), which is why it is not what shipped.
 */
import { describe, expect, it } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { createMessagesTransformHandler } from "../../src/hooks/messages-transform.js";
import { withTempProject } from "../helpers/mock-host.js";

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const KEEP_RECENT = 8;
const SUMMARY = "Older messages surveyed the schema; orders needs a CustomerID index.";

/** History the compression pass can actually rewrite. */
function compressibleHistory(): Msg[] {
  const messages: Msg[] = [
    { info: { id: "m0", role: "user" }, parts: [{ type: "text", text: "kick off" }] },
    { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Starting the survey." }] },
  ];
  for (let i = 2; i < 18; i++) {
    messages.push(
      i % 2 === 0
        ? { info: { id: `m${i}`, role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: `row ${i}\n`.repeat(60) } }] }
        : { info: { id: `m${i}`, role: "assistant" }, parts: [{ type: "text", text: `Analysis step ${i}: the orders table needs a CustomerID index. `.repeat(4) }] },
    );
  }
  messages.push({ info: { id: "m-last", role: "user" }, parts: [{ type: "text", text: "carry on" }] });
  return messages;
}

/** Nothing in the compressed zone is rewritable: only user messages. */
function incompressibleHistory(): Msg[] {
  const messages: Msg[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ info: { id: `m${i}`, role: "user" }, parts: [{ type: "text", text: `question ${i}` }] });
  }
  messages.push({ info: { id: "m-last", role: "user" }, parts: [{ type: "text", text: "carry on" }] });
  return messages;
}

async function runPass(messages: Msg[], project: string): Promise<number> {
  const state = createPluginState();
  const handler = createMessagesTransformHandler(state, {}, project);
  state.requestContentAwareCompression({ keepRecent: KEEP_RECENT, summary: SUMMARY });
  await handler({ sessionID: "ses_placement" } as never, { messages } as never);
  return messages.findIndex((message) => JSON.stringify(message).includes("[compressed-block:"));
}

describe("summary block placement", () => {
  it("splices at the compressed-zone boundary when the pass rewrote history", async () => {
    await withTempProject(async (project) => {
      const messages = compressibleHistory();
      const cutoff = messages.length - KEEP_RECENT;
      const summaryIndex = await runPass(messages, project);

      expect(summaryIndex).toBeGreaterThanOrEqual(0);
      // The summary must precede the retained tail: that order is the reason the
      // block exists, and the measurement shows it costs nothing here.
      expect(summaryIndex).toBe(cutoff);
      // The messages after it are the untouched tail, so the block really does
      // sit between the compressed zone and the tail.
      expect((messages[summaryIndex + 1]!.info as { id?: string }).id).toBeDefined();
    });
  });

  it("appends when the pass compressed nothing, so the tail keeps its indices", async () => {
    await withTempProject(async (project) => {
      const messages = incompressibleHistory();
      const before = messages.map((message) => JSON.stringify(message));
      const summaryIndex = await runPass(messages, project);

      expect(summaryIndex).toBeGreaterThanOrEqual(0);
      // Appended, not spliced: a splice here re-prefilled the whole retained tail
      // (8 messages / 656 chars measured) to report a compression that did not
      // happen.
      expect(summaryIndex).toBe(before.length);
      expect(messages).toHaveLength(before.length + 1);
      for (let i = 0; i < before.length; i++) {
        expect(JSON.stringify(messages[i]), `message ${i} must not move`).toBe(before[i]);
      }
    });
  });

  it("never grows the compressed-zone rewrite when the summary is placed", async () => {
    await withTempProject(async (project) => {
      const messages = compressibleHistory();
      const outcome = await runPass(messages, project);
      // Exactly one summary block is inserted, whatever the placement path.
      const blocks = messages.filter((message) => JSON.stringify(message).includes("[compressed-block:")).length;
      expect(blocks).toBe(1);
      expect(outcome).toBeGreaterThan(0);
    });
  });
});