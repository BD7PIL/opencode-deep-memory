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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { v2Setup, buildV2Client } from "../../src/v2/entry.js";
import { appendDebugLine } from "../../src/v2/debug-channel.js";
import { mockV2Ctx } from "../helpers/mock-host.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dm-cache-"));
}

/**
 * deepMemoryPlugin memoizes its hooks on globalThis, which is deliberate
 * idempotency in production (a v2 engine can load the plugin twice, once per
 * worker context) but would leak one test's project directory into the next.
 */
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
});

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

describe("invariant 2 — injected system block is byte-stable across turns", () => {
  const MEMORY = "# Project Memory\n\n## Gotchas\n- byte-stability anchor [2026-10-20]\n";

  /**
   * 0.15.x asserted a *sync* context handler because the 2.0.27 spike found
   * post-await mutations were lost. On 2.0.32 the host awaits the handler, so
   * the invariant that matters is the cache one: an unchanged MEMORY.md must
   * yield a byte-identical injected block, and a MEMORY.md write must move
   * exactly one turn.
   */
  it("unchanged MEMORY.md → identical block; a write moves exactly one turn", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const context = host.handlerFor("session", "context")!;

      const turn = async (): Promise<string> => {
        const event = {
          sessionID: "ses_stab",
          agent: "build",
          model: { id: "m", providerID: "p" },
          system: [{ type: "text", text: "base prompt" }],
          messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "q" }] }],
        };
        await context(event);
        return JSON.stringify(event.system);
      };

      const stable = await turn();
      expect(await turn()).toBe(stable);

      // A MEMORY.md write is the one legitimate change. Bump the clock so the
      // mtime cache is guaranteed to notice, rather than relying on write
      // ordering within the same millisecond.
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY + "- added line [2026-10-20]\n");
      const changed = await turn();
      expect(changed).not.toBe(stable);

      const restabilized = await turn();
      expect(restabilized).toBe(changed);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  /**
   * Tool definitions precede every system and message block in the provider
   * prefix, so any churn there invalidates everything downstream.
   */
  it("tool definitions are byte-stable and identically ordered across host reloads", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);

      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
      const first = mockV2Ctx({ directory: project });
      await v2Setup(first.ctx as never);
      const snapshot = JSON.stringify([...first.toolRegistry.keys()]);

      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
      const second = mockV2Ctx({ directory: project });
      await v2Setup(second.ctx as never);
      expect(JSON.stringify([...second.toolRegistry.keys()])).toBe(snapshot);
      expect(snapshot.length).toBeGreaterThan(2);
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
        // v2 exposes no session.messages; the read face is session.context.
        async context() {
          return {
            data: [
              { id: "m1", type: "user", text: "hi" },
              { id: "m2", type: "assistant", content: [{ type: "text", text: "plain string part" }] },
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

  it("appends one timestamped line to DEEP_MEMORY_LOG_FILE when enabled, and stays silent for falsy gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-debug-"));
    const logFile = join(dir, "nested", "debug.log"); // dir must be created by the channel
    const savedDebug = process.env["DEEP_MEMORY_DEBUG"];
    const savedFile = process.env["DEEP_MEMORY_LOG_FILE"];
    try {
      process.env["DEEP_MEMORY_DEBUG"] = "1";
      process.env["DEEP_MEMORY_LOG_FILE"] = logFile;
      appendDebugLine("hello channel");
      const content = readFileSync(logFile, "utf-8");
      expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] hello channel\n$/);

      // "0" and "false" are the documented off-switches, not just "unset".
      for (const off of ["0", "false"]) {
        process.env["DEEP_MEMORY_DEBUG"] = off;
        appendDebugLine("must not appear");
      }
      expect(readFileSync(logFile, "utf-8")).not.toContain("must not appear");
    } finally {
      if (savedDebug === undefined) delete process.env["DEEP_MEMORY_DEBUG"];
      else process.env["DEEP_MEMORY_DEBUG"] = savedDebug;
      if (savedFile === undefined) delete process.env["DEEP_MEMORY_LOG_FILE"];
      else process.env["DEEP_MEMORY_LOG_FILE"] = savedFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
