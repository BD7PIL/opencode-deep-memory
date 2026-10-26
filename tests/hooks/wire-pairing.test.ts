/**
 * Wire-pairing regression — 2026-10-27 EL7 incident.
 *
 * Stripping the reasoning part from an old assistant message whose text is
 * whitespace-only left the message as [whitespace text, tool part]. The
 * engine's wire conversion drops assistant messages with empty text but still
 * emits their tool results — an orphaned `tool` message with no preceding
 * `tool_calls`. DeepSeek rejects the whole request ("Messages with role 'tool'
 * must be a response to a preceding message with 'tool_calls'"); lenient
 * providers accept it, which is why the failure looked model-specific.
 *
 * Contract: after the transform, NO assistant message may be left as
 * [whitespace text + tool part] with its reasoning gone — that exact shape is
 * what becomes an orphaned tool result on the wire. Messages with substantive
 * text still get their reasoning stripped.
 */
import { describe, it, expect } from "vitest";
import { createMessagesTransformHandler } from "../../src/hooks/messages-transform.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

type Wrap = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

function toolPart(callID: string, output: string): Record<string, unknown> {
  return { type: "tool", callID, tool: "shell", state: { status: "completed", input: { command: "ls" }, output } };
}

const WS_TEXT = "\n\n\n";

function build(target: Wrap): Wrap[] {
  const padFn = (i: number): Wrap => ({ info: { role: "user" }, parts: [{ type: "text", text: "padFn " + i }] });
  return [
    padFn(0),
    padFn(1),
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    target,
    ...Array.from({ length: 12 }, (_, i) => padFn(2 + i)),
  ];
}

async function transform(messages: Wrap[]): Promise<Wrap[]> {
  const h = createMessagesTransformHandler(
    createPluginState(),
    { session: { messages: async () => ({ data: [] }) }, tui: {}, config: { get: async () => ({ data: undefined }) } } as never,
    "/tmp/wire-pairing-test",
  );
  const output = { messages: messages as never };
  await h({ sessionID: "s" } as never, output as never);
  return output.messages as unknown as Wrap[];
}

function isOrphanShape(m: Wrap): boolean {
  if (m.info.role !== "assistant") return false;
  const hasTool = m.parts.some((p) => p.type === "tool");
  const reasoning = m.parts.some((p) => p.type === "reasoning" || p.type === "thinking");
  const substantiveText = m.parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "");
  return hasTool && !reasoning && !substantiveText;
}

describe("messages.transform wire-pairing guard", () => {
  it("never leaves [whitespace text + tool] assistants without reasoning (the orphan shape)", async () => {
    const out = await transform(
      build({
        info: { role: "assistant" },
        parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: WS_TEXT }, toolPart("call-1", "file listing")],
      }),
    );
    const bad = out.filter(isOrphanShape);
    expect(bad).toEqual([]);
    const kept = out.find((m) => m.parts.some((p) => p.type === "tool" && p.callID === "call-1"));
    expect(kept?.parts.some((p) => p.type === "reasoning")).toBe(true);
  });

  it("still strips reasoning from messages with substantive text", async () => {
    const out = await transform(
      build({
        info: { role: "assistant" },
        parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Verdict: mapping confirmed." }, toolPart("call-2", "file listing")],
      }),
    );
    const msg = out.find((m) => m.parts.some((p) => p.type === "tool" && p.callID === "call-2"));
    expect(msg?.parts.some((p) => p.type === "reasoning")).toBe(false);
    expect(msg?.parts.some((p) => p.type === "text" && String(p.text).includes("Verdict"))).toBe(true);
  });

  it("removes whitespace-only assistants without tools entirely (safe: no tool parts to orphan)", async () => {
    const out = await transform(
      build({ info: { role: "assistant" }, parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "   \n" }] }),
    );
    const bad = out.filter(isOrphanShape);
    expect(bad).toEqual([]);
  });
});
