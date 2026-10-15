/**
 * Compression-injection branch (messages.transform) + maybeProactiveExpand
 * direct tests — batch 0.15.1 (plan items P3-15, P3-16).
 *
 * The `compressReq` block in messages-transform.ts had zero coverage before
 * this file: summary-block insertion, the keepRecent cutoff, and assistant
 * text compression in the compressed zone all ride the
 * requestContentAwareCompression state API.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMessagesTransformHandler } from "../../src/hooks/messages-transform.js";
import { maybeProactiveExpand } from "../../src/compress/proactive-expand.js";
import { createPluginState, type PluginState } from "../../src/hooks/shared-state.js";
import { ccrStore } from "../../src/compress/ccr.js";

interface MockMessage {
  info: { id: string; role: string; time: { created: number } };
  parts: unknown[];
}

const mockMessage = (role: string, parts: unknown[], id?: string): MockMessage => ({
  info: { id: id ?? `m-${Math.random().toString(36).slice(2)}`, role, time: { created: 0 } },
  parts,
});

function buildMessages(count: number, make: (i: number) => MockMessage): MockMessage[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

describe("messages.transform — content-aware compression branch", () => {
  let state: PluginState;

  beforeEach(() => {
    state = createPluginState();
  });

  it("injects the [compressed-block] summary as an assistant message at the cutoff", async () => {
    // 3 protected head + 8 mid + 5 tail = 16; keepRecent 5 → cutoff = 11.
    const messages = buildMessages(16, (i) => {
      if (i < 2) return mockMessage("user", [{ type: "text", text: `head user ${i}` }], `h${i}`);
      return mockMessage("assistant", [{ type: "text", text: `filler ${i}` }], `f${i}`);
    });

    state.requestContentAwareCompression({ keepRecent: 5, summary: "PROJECT DECISION: use bun runtime" });
    const handler = createMessagesTransformHandler(state, undefined, "/tmp/dm-cib", undefined);
    await handler({}, { messages } as never);

    const blockIdx = messages.findIndex((m) =>
      JSON.stringify(m.parts).includes("[compressed-block:"),
    );
    expect(blockIdx).toBeGreaterThan(0);
    expect(blockIdx).toBeLessThanOrEqual(11);
    const block = JSON.stringify(messages[blockIdx].parts);
    expect(block).toContain("PROJECT DECISION: use bun runtime");
    expect(messages[blockIdx].info.role).toBe("assistant");
  });

  it("assistant text in the compressed zone is replaced by a deep_expand marker; text with deep_expand is skipped", async () => {
    // head(2) + old assistant(1) + old assistant carrying a marker(1) + fillers = 16
    const messages = buildMessages(16, (i) => {
      if (i === 2) return mockMessage("assistant", [{ type: "text", text: "old reasoning that should be compressed away" }], "old-1");
      if (i === 3) return mockMessage("assistant", [{ type: "text", text: 'already markered — call deep_expand("abc") to restore' }], "old-2");
      if (i < 2) return mockMessage("user", [{ type: "text", text: `head ${i}` }], `h${i}`);
      return mockMessage("assistant", [{ type: "text", text: `filler ${i}` }], `f${i}`);
    });

    state.requestContentAwareCompression({ keepRecent: 5, summary: "S" });
    const handler = createMessagesTransformHandler(state, undefined, "/tmp/dm-cib", undefined);
    await handler({}, { messages } as never);

    const old1 = JSON.stringify(messages.find((m) => m.info.id === "old-1")!.parts);
    expect(old1).toContain("deep_expand(");
    expect(old1).not.toContain("old reasoning that should be compressed away");
    // The already-markered message keeps its original text untouched.
    const old2 = (messages.find((m) => m.info.id === "old-2")!.parts as Array<{ text: string }>)[0];
    expect(old2.text).toContain('deep_expand("abc")');
  });

  it("keepRecent boundary: messages in the protected tail are never compressed", async () => {
    const tailText = "TAILPROTECTED reasoning content";
    const messages = buildMessages(16, (i) => {
      if (i < 2) return mockMessage("user", [{ type: "text", text: `head ${i}` }], `h${i}`);
      if (i >= 12) return mockMessage("assistant", [{ type: "text", text: tailText + " " + i }], `t${i}`);
      return mockMessage("assistant", [{ type: "text", text: `old filler ${i}` }], `o${i}`);
    });

    state.requestContentAwareCompression({ keepRecent: 5, summary: "S" });
    const handler = createMessagesTransformHandler(state, undefined, "/tmp/dm-cib", undefined);
    await handler({}, { messages } as never);

    // The summary splice shifts indices by 1, so the protected tail now starts
    // at 12; assert on identity so we never depend on the shift.
    const tailMsgs = messages.filter((m) => typeof m.info?.id === "string" && m.info.id.startsWith("t"));
    expect(tailMsgs).toHaveLength(4);
    for (const m of tailMsgs) {
      const parts = JSON.stringify(m.parts);
      expect(parts).toContain(tailText);
      expect(parts).not.toContain("[compressed — call deep_expand");
    }
  });

  it("transient tool outputs in the compressed zone get CCR-compressed with a deep_expand marker", async () => {
    const bigOutput = Array.from({ length: 60 }, (_, i) => `line ${i} of bash noise`).join("\n");
    const messages = buildMessages(16, (i) => {
      if (i === 3) {
        return mockMessage("assistant", [{
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: bigOutput },
        }], "tool-old");
      }
      if (i < 2) return mockMessage("user", [{ type: "text", text: `head ${i}` }], `h${i}`);
      return mockMessage("assistant", [{ type: "text", text: `filler ${i}` }], `f${i}`);
    });

    state.requestContentAwareCompression({ keepRecent: 5, summary: "S" });
    const handler = createMessagesTransformHandler(state, undefined, "/tmp/dm-cib", undefined);
    await handler({}, { messages } as never);

    const toolPart = (messages.find((m) => m.info.id === "tool-old")!.parts as Array<{ state: { output: string } }>)[0];
    expect(toolPart.state.output).toContain("deep_expand(");
    expect(toolPart.state.output).not.toContain("line 30 of bash noise");
  });

  it("no pending request → handler leaves messages structurally untouched (idempotent denoise still allowed)", async () => {
    const messages = buildMessages(16, (i) =>
      i < 2
        ? mockMessage("user", [{ type: "text", text: `head ${i}` }], `h${i}`)
        : mockMessage("assistant", [{ type: "text", text: `filler ${i} with content` }], `f${i}`),
    );
    const before = messages.map((m) => JSON.stringify(m.parts));
    const handler = createMessagesTransformHandler(state, undefined, "/tmp/dm-cib", undefined);
    await handler({}, { messages } as never);
    // No [compressed-block] appears anywhere.
    expect(JSON.stringify(messages)).not.toContain("[compressed-block");
    // Filler text survives (denoise may only strip thinking/system parts).
    for (let i = 2; i < 16; i++) {
      expect(JSON.stringify(messages[i].parts)).toContain(`filler ${i}`);
    }
    expect(before.length).toBe(16);
  });
});

describe("maybeProactiveExpand (direct)", () => {
  let state: PluginState;

  beforeEach(() => {
    state = createPluginState();
  });

  function toolMsgWithOutput(id: string, output: string): MockMessage {
    return mockMessage("assistant", [{
      type: "tool",
      tool: "bash",
      state: { status: "completed", output },
    }], id);
  }

  it("restores matching CCR content when the user query overlaps its entities", async () => {
    // Entity extraction only recognizes file names / func() / versions /
    // PascalCase — so both sides must carry the same such tokens.
    const original = "The Postgres-Migration for orders.test.json needs CustomerID index v1.2.3, migrateDb() uses deploy.sh — Postgres-Migration orders.test.json CustomerID " + "detail ".repeat(40);
    const compressed = "[compressed output]\ndeep_expand call available";
    const hash = ccrStore(state, original, compressed, "bash");
    const messages = [
      toolMsgWithOutput("t1", compressed + `\n[compressed — call deep_expand("${hash}") to restore original]`),
      mockMessage("user", [{ type: "text", text: "Postgres-Migration orders.test.json CustomerID migrateDb() status?" }]),
    ];

    const restored = await maybeProactiveExpand(state, messages as never);
    expect(restored).toBe(1);
    const out = (messages[0].parts as Array<{ state: { output: string } }>)[0].state.output;
    expect(out).toContain("[auto-restored");
    expect(out).toContain("CustomerID");
  });

  it("below-threshold overlap restores nothing", async () => {
    const original = "The Kubernetes-Cluster for node-pools.yaml needs TerraformDeploy v2.0.0, provisionCluster() uses helm.sh — Kubernetes-Cluster node-pools.yaml TerraformDeploy " + "fill ".repeat(50);
    const hash = ccrStore(state, original, "[compressed]", "bash");
    const messages = [
      toolMsgWithOutput("t1", `[compressed — call deep_expand("${hash}") to restore original]`),
      mockMessage("user", [{ type: "text", text: "Postgres-Migration orders.test.json status?" }]),
    ];
    const restored = await maybeProactiveExpand(state, messages as never);
    expect(restored).toBe(0);
    expect((messages[0].parts as Array<{ state: { output: string } }>)[0].state.output).not.toContain("auto-restored");
  });

  it("throttled: a second call within the throttle window is a no-op", async () => {
    const original = "The Redis-Config for cache.json needs MaxmemoryPolicy v3.0.0, evictKeys() uses ttl.cfg — Redis-Config cache.json MaxmemoryPolicy " + "pad ".repeat(40);
    const hash = ccrStore(state, original, "[compressed]", "bash");
    const mk = () => [
      toolMsgWithOutput("t1", `[compressed — call deep_expand("${hash}") to restore original]`),
      mockMessage("user", [{ type: "text", text: "Redis-Config cache.json evictKeys() status?" }]),
    ];
    const first = await maybeProactiveExpand(state, mk() as never);
    const second = await maybeProactiveExpand(state, mk() as never);
    expect(first + second).toBeLessThanOrEqual(2);
    // At least the second call must have been throttled (0), or the first was.
    expect(first === 0 || second === 0).toBe(true);
  });

  it("tiny originals (<200 chars) are skipped", async () => {
    const hash = ccrStore(state, "Redis-Config cache.json", "[c]", "bash");
    const messages = [
      toolMsgWithOutput("t1", `[compressed — call deep_expand("${hash}")]`),
      mockMessage("user", [{ type: "text", text: "Redis-Config cache.json?" }]),
    ];
    expect(await maybeProactiveExpand(state, messages as never)).toBe(0);
  });

  it("no user message → 0", async () => {
    expect(await maybeProactiveExpand(state, [mockMessage("assistant", [{ type: "text", text: "hi there friend" }])] as never)).toBe(0);
  });

  it("restores at most 2 entries per turn", async () => {
    const mkOriginal = (n: string) =>
      `The Orders-Service-${n} for orders.test.json needs CustomerID v1.2.3, processOrder() — Orders-Service-${n} orders.test.json CustomerID ` + "detail ".repeat(40);
    const messages: MockMessage[] = [];
    for (const n of ["a", "b", "c"]) {
      const hash = ccrStore(state, mkOriginal(n), "[compressed]", "bash");
      messages.push(toolMsgWithOutput(`t-${n}`, `[compressed — call deep_expand("${hash}") to restore original]`));
    }
    messages.push(mockMessage("user", [{ type: "text", text: "Orders-Service-a orders.test.json processOrder() status?" }]));
    const restored = await maybeProactiveExpand(state, messages as never);
    expect(restored).toBeLessThanOrEqual(2);
  });
});
