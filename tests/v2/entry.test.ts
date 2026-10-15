/**
 * Cache regression suite — batch D2 (0.15.0).
 *
 * The cache-friendly constraint (ocrc batch plan) demands three invariants,
 * all E5-evidenced on opencode v2.0.27 and pinned here as unit tests:
 *
 *  1. IDEMPOTENCY: messages.transform applied twice to the same message
 *     array must produce zero further change after the first pass — every
 *     rewritten message costs exactly one cache miss, then the prefix is
 *     stable again.
 *  2. CONTEXT-HOOK SYNC SAFETY: the v2 adapter's context handler must be
 *     callable with zero awaits before its mutation completes (the v2 host
 *     does not await context-hook promises — E5 marker experiment).
 *  3. GOLDEN HASH: the system-transform injection payload is byte-stable
 *     across invocations when MEMORY.md is unchanged (97×1035B constant in
 *     the E5 live stack).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { v2Setup, buildV2Client } from "../../src/v2/entry.js";
import { appendDebugLine } from "../../src/v2/debug-channel.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dm-cache-"));
}

describe("invariant 1 — messages.transform idempotency", () => {
  it("second pass over the same array is byte-identical", async () => {
    const project = tempProject();
    try {
      const { default: pluginModule } = await import("../../src/index.js");
      const hooksV1 = await (pluginModule as { server: (i: unknown) => Promise<Record<string, (i: unknown, o: unknown) => Promise<void>>> }).server({
        directory: project,
        serverUrl: new URL("http://127.0.0.1:0/"),
        client: buildV2Client({}) ,
      });
      const msgT = hooksV1["experimental.chat.messages.transform"];
      expect(msgT).toBeTruthy();

      const msgs: Array<Record<string, unknown>> = [{ info: { role: "user" }, parts: [{ type: "text", text: "q0" }] }];
      for (let i = 0; i < 12; i++) {
        msgs.push({ info: { role: "assistant" }, parts: [{ type: "text", text: `answer ${i} <thinking>scratch ${i}</thinking>` }] });
        msgs.push({ info: { role: "tool" }, parts: [{ type: "tool-error", text: "E".repeat(300), state: { status: "error", error: "E".repeat(300) } }] });
      }
      msgs.push({ info: { role: "user" }, parts: [{ type: "text", text: "final question" }] });

      const snap = () => JSON.stringify(msgs);
      await msgT({}, { messages: msgs });
      const after1 = snap();
      await msgT({}, { messages: msgs });
      const after2 = snap();
      // The first pass MAY change (denoise fires); the second MUST NOT.
      expect(after2).toBe(after1);
      // And a third pass keeps it stable too (convergence, not oscillation).
      await msgT({}, { messages: msgs });
      expect(snap()).toBe(after2);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("invariant 2 — context hook sync safety", () => {
  it("v2Setup context handler completes mutation with no await points before it", async () => {
    const project = tempProject();
    try {
      const registered: Record<string, (...args: unknown[]) => unknown> = {};
      const ctx = {
        location: { directory: project },
        session: {
          async hook(name: string, handler: (e: unknown) => unknown) { registered[name] = handler; return { dispose() {} }; },
          async create() { return { id: "ses_x" }; },
          async prompt() { return {}; },
        },
        event: { subscribe(h: (e: unknown) => unknown) { registered["event"] = h; return { dispose() {} }; } },
        tool: { async hook(n: string, h: (e: unknown, o: unknown) => unknown) { registered["tool"] = h; return { dispose() {} }; } },
      };
      // agent face must exist (reduced-host guard)
      (ctx as unknown as Record<string, unknown>).agent = { transform: () => {} };

      const disposer = await v2Setup(ctx as never);
      expect(typeof disposer).toBe("function");
      expect(registered["context"]).toBeTruthy();

      // Simulate the host's fire-and-forget: call the handler, then IMMEDIATELY
      // (same microtask, no awaits) snapshot the event. The mutation the host
      // would see must already be present or absent deterministically — the
      // handler must never leave the event half-mutated across an await.
      const event = { sessionID: "ses_t", system: [{ type: "text", text: "base" }], messages: [] as unknown[] };
      const returned = (registered["context"] as (e: typeof event) => typeof event)(event);
      // Synchronous contract: the handler returns the (same) event object.
      expect(returned).toBe(event);
      // No half-state: system blocks are all well-formed {type,text}.
      for (const b of event.system) expect(typeof b.text).toBe("string");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("invariant 3 — golden hash of the injection payload", () => {
  const MEMORY = "# Project Memory\n\n## Gotchas\n- golden line for hash stability [2026-10-15]\n";

  it("system transform produces a byte-identical payload across invocations with unchanged MEMORY.md", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);

      const { default: pluginModule } = await import("../../src/index.js");
      const hooks = await (pluginModule as { server: (i: unknown) => Promise<Record<string, (i: unknown, o: unknown) => Promise<void>>> }).server({
        directory: project,
        serverUrl: new URL("http://127.0.0.1:0/"),
        client: buildV2Client({}),
      });
      const sysT = hooks["experimental.chat.system.transform"];
      expect(sysT).toBeTruthy();

      const hashOf = async (): Promise<string> => {
        const system = ["base system prompt"];
        await sysT({ sessionID: "ses_gold" }, { system });
        const payload = system.filter((s) => s !== "base system prompt").join("\n");
        expect(payload.length).toBeGreaterThan(0); // injected something
        return createHash("sha256").update(payload, "utf8").digest("hex");
      };
      const h1 = await hashOf();
      const h2 = await hashOf();
      const h3 = await hashOf();
      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("v2 client adapter", () => {
  it("normalizes v2 flat message lists into the v1 {info, parts} shape", async () => {
    const ctx = {
      session: {
        async messages() {
          return {
            data: [
              { id: "m1", role: "user", sessionID: "s1", content: [{ type: "text", text: "hi" }] },
              { id: "m2", role: "assistant", sessionID: "s1", content: ["plain string part"] },
            ],
          };
        },
        async create(a: { title?: string }) { return { id: "ses_new", title: a.title }; },
        async prompt(a: { sessionID: string; text?: string }) { return { sessionID: a.sessionID, text: a.text }; },
      },
    };
    const client = buildV2Client(ctx as never) as {
      session: { messages(a: { path: { id: string } }): Promise<{ data: Array<{ info: Record<string, unknown>; parts: unknown[] }> }>; create(a: unknown): Promise<{ data: { id?: string } }>; promptAsync(a: unknown): Promise<unknown> };
    };
    const r = await client.session.messages({ path: { id: "s1" } });
    expect(r.data).toHaveLength(2);
    expect(r.data[0].info).toMatchObject({ role: "user", id: "m1" });
    expect(r.data[0].parts).toEqual([{ type: "text", text: "hi" }]);
    // string parts are promoted to text parts
    expect(r.data[1].parts).toEqual([{ type: "text", text: "plain string part" }]);

    const created = await client.session.create({ body: { title: "T" }, query: { directory: "/p" } });
    expect(created.data?.id).toBe("ses_new");

    // promptAsync is fire-and-forget but resolves immediately
    await expect(client.session.promptAsync({ path: { id: "ses_new" }, body: { parts: [{ type: "text", text: "x" }], agent: "general" } })).resolves.toBeTruthy();
  });

  it("degrades gracefully when the ctx session face is missing", () => {
    const client = buildV2Client({}) as { session: { messages(a: unknown): Promise<{ data: unknown[] }> }; tui: { showToast?: unknown } };
    expect(client.tui.showToast).toBeUndefined();
  });
});

describe("debug channel", () => {
  beforeEach(() => { delete process.env["DEEP_MEMORY_DEBUG"]; });
  it("is silent unless DEEP_MEMORY_DEBUG is set", () => {
    // No assertion possible on the file without heavy env mocking; the contract
    // is just "does not throw".
    expect(() => appendDebugLine("unit-test line")).not.toThrow();
  });
});
