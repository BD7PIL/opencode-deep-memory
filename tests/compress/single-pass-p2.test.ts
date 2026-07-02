import { describe, it, expect } from "vitest";
import { singlePassCompress } from "../../src/compress/single-pass.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

interface Message {
  info: { role: string };
  parts: unknown[];
}

function makeAssistantText(text: string): Message {
  return {
    info: { role: "assistant" },
    parts: [{ type: "text", text }],
  };
}

const HEADING = "## Important Heading";
const BULLET_LINES = Array.from({ length: 30 }, (_, i) => `- bullet point ${i} that is long enough to be meaningful`).join("\n");
const NUMBERED_LINES = Array.from({ length: 30 }, (_, i) => `${i + 1}. numbered step ${i} that is long enough to be meaningful`).join("\n");
const PROSE_LINES = Array.from({ length: 30 }, (_, i) => `This is prose paragraph ${i} that fills space and should be compressed away.`).join("\n");

describe("P2: compressAssistantText keep-pattern tightening", () => {
  it("does NOT keep bullet points (removed in V5)", () => {
    const state = createPluginState();
    const text = `${HEADING}\n${BULLET_LINES}\n${PROSE_LINES}`;
    const messages: Message[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      makeAssistantText(text),
    ];

    singlePassCompress(messages as never, state, 100);

    const compressed = (messages[2].parts[0] as Record<string, unknown>)["text"] as string;
    // bullets should be mostly gone (maybe 1-2 survive in head/tail)
    const bulletCount = (compressed.match(/^- bullet/gm) || []).length;
    expect(bulletCount).toBeLessThan(5);
  });

  it("KEEPS numbered lists (preserved in V5)", () => {
    const state = createPluginState();
    const text = `${HEADING}\n${NUMBERED_LINES}\n${PROSE_LINES}`;
    const messages: Message[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      makeAssistantText(text),
    ];

    singlePassCompress(messages as never, state, 100);

    const compressed = (messages[2].parts[0] as Record<string, unknown>)["text"] as string;
    // numbered lists should be kept
    const numberedCount = (compressed.match(/^\d+\.\s/gm) || []).length;
    expect(numberedCount).toBeGreaterThan(5);
  });

  it("KEEPS headings and error lines", () => {
    const state = createPluginState();
    const errorLine = "ERROR: something failed critically";
    const text = `${HEADING}\n${PROSE_LINES}\n${errorLine}\n${PROSE_LINES}`;
    const messages: Message[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      makeAssistantText(text),
    ];

    singlePassCompress(messages as never, state, 100);

    const compressed = (messages[2].parts[0] as Record<string, unknown>)["text"] as string;
    expect(compressed).toContain("Important Heading");
    expect(compressed).toContain("ERROR");
  });

  it("achieves higher compression ratio (0.7 threshold allows more compression)", () => {
    const state = createPluginState();
    const text = `${HEADING}\n${BULLET_LINES}\n${NUMBERED_LINES}\n${PROSE_LINES}`;
    const messages: Message[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
      makeAssistantText(text),
    ];

    singlePassCompress(messages as never, state, 100);

    const compressed = (messages[2].parts[0] as Record<string, unknown>)["text"] as string;
    // With 0.7 threshold (vs 0.6), more aggressive compression allowed
    // text should be significantly smaller (bullets dropped, only headings/numbers/errors kept)
    expect(compressed.length).toBeLessThan(text.length * 0.75);
  });
});
