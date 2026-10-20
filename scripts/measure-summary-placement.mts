/**
 * Measure the prompt-cache cost of the summary-block insertion placement.
 *
 * Stage 4 of the v2 re-adaptation called for replacing the mid-array splice
 * (`messages.splice(cutoff, 0, summaryMsg)`) with "append-then-cut". This script
 * produces the numbers that decide whether that instruction actually buys
 * anything on THIS code path, instead of arguing about it.
 *
 * Method: drive the real `createMessagesTransformHandler` with a pending
 * context_compress request, then compare the outgoing sequence against the
 * pre-transform sequence for three placements of the same summary:
 *
 *   A  splice at `cutoff`           (what the code does today)
 *   B  append at the end of the array  (the literal append-then-cut reading)
 *   C  append onto the compressed zone's last message  (no index shift)
 *
 * All three carry the IDENTICAL compression mutations, because they are derived
 * from the real pass's own output — only the summary's position differs. The
 * metric is the cached-prefix length: a provider prefix cache matches a
 * contiguous run from the start, so the first differing message index is the
 * last index that could still be served from cache, and everything after it is
 * re-prefilled.
 *
 * Run: npx tsx scripts/measure-summary-placement.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginState } from "../src/hooks/shared-state.js";
import { createMessagesTransformHandler } from "../src/hooks/messages-transform.js";

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const KEEP_RECENT = 8;

/** A conversation with compressible history: long tool outputs + old assistant text. */
function realisticConversation(): Msg[] {
  const messages: Msg[] = [
    { info: { id: "m0", role: "user" }, parts: [{ type: "text", text: "kick off the migration" }] },
    { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Starting with the schema survey." }] },
  ];
  for (let i = 2; i < 18; i++) {
    if (i % 2 === 0) {
      messages.push({
        info: { id: `m${i}`, role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: `row ${i}\n`.repeat(60) } }],
      });
    } else {
      messages.push({
        info: { id: `m${i}`, role: "assistant" },
        parts: [{ type: "text", text: `Analysis step ${i}: the orders table needs a CustomerID index. `.repeat(4) }],
      });
    }
  }
  messages.push({ info: { id: "m-last", role: "user" }, parts: [{ type: "text", text: "carry on" }] });
  return messages;
}

/**
 * The degenerate shape: the compressed zone holds only user messages, so the
 * compression pass rewrites NOTHING and the summary insert is the sole mutation.
 */
function degenerateConversation(): Msg[] {
  const messages: Msg[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ info: { id: `m${i}`, role: "user" }, parts: [{ type: "text", text: `question ${i}` }] });
  }
  messages.push({ info: { id: "m-last", role: "user" }, parts: [{ type: "text", text: "carry on" }] });
  return messages;
}

interface Measurement {
  variant: string;
  cachedPrefix: number;
  rePrefilledMessages: number;
  rePrefilledChars: number;
  tailIndexShifted: boolean;
}

function snapshot(messages: Msg[]): string[] {
  return messages.map((message) => JSON.stringify(message));
}

function measure(variant: string, candidate: Msg[], pre: string[]): Measurement {
  const serialized = snapshot(candidate);
  let firstDifference = 0;
  const limit = Math.min(pre.length, serialized.length);
  while (firstDifference < limit && pre[firstDifference] === serialized[firstDifference]) firstDifference += 1;
  if (firstDifference === limit && pre.length === serialized.length) {
    firstDifference = pre.length;
  }
  const rePrefilledMessages = Math.max(0, pre.length - firstDifference);
  const rePrefilledChars = pre.slice(firstDifference).join("").length;
  // Did inserting the summary move the retained tail's indices?
  const tailIndexShifted = candidate.length !== pre.length && candidate[pre.length - 1] !== undefined
    ? serialized[pre.length - 1] !== pre[pre.length - 1]
    : true;
  return { variant, cachedPrefix: firstDifference, rePrefilledMessages, rePrefilledChars, tailIndexShifted };
}

function report(title: string, rows: Measurement[]): void {
  console.log(`\n=== ${title} ===`);
  console.log("variant                                    cachedPrefix  rePrefilled(msgs)  rePrefilled(chars)  tailIndexShifted");
  for (const row of rows) {
    console.log(
      `${row.variant.padEnd(42)} ${String(row.cachedPrefix).padStart(12)} ${String(row.rePrefilledMessages).padStart(18)} ` +
        `${String(row.rePrefilledChars).padStart(18)} ${String(row.tailIndexShifted).padStart(18)}`,
    );
  }
  const baseline = rows.find((row) => row.variant.startsWith("A"));
  console.log("-- delta vs A (negative rePrefilled(msgs) = better):");
  for (const row of rows) {
    console.log(
      `${row.variant.padEnd(42)} msgs ${String(row.rePrefilledMessages - baseline!.rePrefilledMessages).padStart(4)}  ` +
        `chars ${String(row.rePrefilledChars - baseline!.rePrefilledChars).padStart(6)}`,
    );
  }
}

async function runScenario(title: string, build: () => Msg[]): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), "dm-measure-"));
  try {
    const state = createPluginState();
    const handler = createMessagesTransformHandler(state, {}, project);
    const messages = build();
    const pre = snapshot(messages);

    state.requestContentAwareCompression({
      keepRecent: KEEP_RECENT,
      summary: "The migration surveyed the schema. orders needs a CustomerID index; deploy.sh runs at v1.2.3.",
    });
    await handler({ sessionID: "ses_measure" } as never, { messages } as never);

    const post = messages as Msg[];
    const serializedPost = snapshot(post);
    const summaryIndex = serializedPost.findIndex((entry) => entry.includes("[compressed-block:"));
    if (summaryIndex < 0) {
      console.log(`\n=== ${title} ===\nno summary block was inserted (the pass compressed nothing) — nothing to compare.`);
      return;
    }
    const summary = post[summaryIndex]!;
    // The insert is the only difference between the shipped output and the
    // pass's compression mutations, so removing the summary recovers the
    // intermediate state whatever placement the code currently chose.
    const intermediate = post.filter((_, index) => index !== summaryIndex);
    const cutoff = pre.length - KEEP_RECENT;
    const summaryParts = summary.parts as Array<Record<string, unknown>>;

    // Every variant is derived from `intermediate`, so the comparison does not
    // depend on which one the shipped code happens to pick.
    const variantA = [...intermediate.slice(0, cutoff), summary, ...intermediate.slice(cutoff)];
    const variantB = [...intermediate, summary];
    const variantC = intermediate.map((message, index) =>
      index === cutoff - 1 ? { ...message, parts: [...message.parts, ...summaryParts] } : message,
    );
    const variantD = intermediate;
    const variantShipped = post;

    report(title, [
      measure("A  splice at cutoff", variantA, pre),
      measure("B  append at end of array", variantB, pre),
      measure("C  append onto compressed-zone last msg", variantC, pre),
      measure("D  insert nothing", variantD, pre),
      measure("SHIPPED  splice when compressed, append when not", variantShipped, pre),
    ]);
    console.log(
      `summary block size: ${JSON.stringify(summary).length} chars; ` +
        `message count ${pre.length} -> ${post.length}; cutoff was ${pre.length - KEEP_RECENT}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runScenario("S1 realistic: the compression pass rewrites history", realisticConversation);
  await runScenario("S2 degenerate: nothing in the compressed zone is rewritable", degenerateConversation);
  console.log(
    "\nReading of the numbers: the cached prefix ends at the FIRST differing message, so a placement\n" +
      "only matters when it is the pass's earliest mutation. When the compression rewrites anything (S1)\n" +
      "the insert position is free — every variant ties, so the ordered placement costs nothing and is\n" +
      "kept. When it rewrites nothing (S2) the insert is the sole mutation: a mid-array splice re-prefills\n" +
      "the whole retained tail, 'no index shift' (C) is WORSE than the splice, and only appending avoids\n" +
      "the tail. The SHIPPED policy takes the splice when something was compressed and the append when\n" +
      "nothing was, which is optimal in both scenarios and never sacrifices order where order matters.\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});