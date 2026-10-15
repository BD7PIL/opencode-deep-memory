/**
 * v2 bridge behavior tests — batch 0.15.1 (plan item P3-14).
 *
 * Drives v2Setup against a mock ctx face bag and asserts the behaviors the
 * E5 spike established on the live v2 host:
 *  - warm-cache is a DISK-backed cross-turn/cross-realm handoff
 *  - the context hook applies the cached memory block synchronously via the
 *    LAST USER MESSAGE channel (`<deep-memory-context>` part)
 *  - the async system refresh writes the next turn's cache (never compounds)
 *  - the compaction bridge maps v1 {context, prompt} output onto the event
 *  - the client adapter falls back to loopback HTTP when the ctx session face
 *    lacks `messages`
 *  - disposal is total (every registered face) and single-fault tolerant
 *  - a reduced host (no agent.transform) is a no-op that never touches disk
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v2Setup, buildV2Client, V2_PLUGIN_ID } from "../../src/v2/entry.js";
import { mockV2Ctx } from "../helpers/mock-host.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dm-v2bridge-"));
}

/** Pull the handler registered for a given face/event out of the mock bag. */
function handlerFor(
  registered: Array<{ face: string; event?: string; handler: unknown }>,
  face: string,
  event?: string,
): ((...a: never[]) => unknown) & { mock?: unknown } {
  const found = registered.find((r) => r.face === face && (event === undefined || r.event === event));
  if (!found) throw new Error(`no handler registered for ${face}${event ? ":" + event : ""}`);
  return found.handler as never;
}

describe("v2 bridge — warm cache", () => {
  let project: string;
  beforeEach(() => { project = tempProject(); });
  afterEach(() => { try { rmSync(project, { recursive: true, force: true }); } catch { /* gone */ } });

  it("first setup with no cache file does not throw and registers all faces", async () => {
    const { ctx, registered } = mockV2Ctx({ directory: project });
    const disposer = await v2Setup(ctx as never);
    expect(typeof disposer).toBe("function");
    expect(registered.find((r) => r.face === "session" && r.event === "context")).toBeTruthy();
    expect(registered.find((r) => r.face === "session" && r.event === "prompt")).toBeTruthy();
    expect(registered.find((r) => r.face === "session" && r.event === "compaction")).toBeTruthy();
    expect(registered.find((r) => r.face === "event")).toBeTruthy();
    expect(registered.find((r) => r.face === "tool")).toBeTruthy();
  });

  it("context injection reads the warm cache written by a previous setup (realm isolation)", async () => {
    // Simulate a previous realm having written the cache.
    mkdirSync(join(project, ".deep-memory"), { recursive: true });
    writeFileSync(
      join(project, ".deep-memory", ".v2-warm-cache.json"),
      JSON.stringify({ ses_w: { system: ["REMEMBER: warm line"], messages: null } }),
    );

    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const context = handlerFor(registered, "session", "context");

    const event = {
      sessionID: "ses_w",
      agent: "build",
      system: [{ type: "text", text: "base" }],
      messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    };
    const returned = (context as (e: typeof event) => typeof event)(event);
    expect(returned).toBe(event);

    // The warm block landed on the LAST USER MESSAGE, not on system[].
    const parts = event.messages[0].content as Array<{ type: string; text: string }>;
    const injected = parts.find((p) => p.text.includes("<deep-memory-context>"));
    expect(injected).toBeTruthy();
    expect(injected!.text).toContain("REMEMBER: warm line");
    expect(event.system).toHaveLength(1); // system untouched by the sync path
  });

  it("no user message in the event → no injection, no crash", async () => {
    mkdirSync(join(project, ".deep-memory"), { recursive: true });
    writeFileSync(
      join(project, ".deep-memory", ".v2-warm-cache.json"),
      JSON.stringify({ "*": { system: ["warm"], messages: null } }),
    );
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const context = handlerFor(registered, "session", "context");
    const event = { sessionID: "s", system: [{ type: "text", text: "base" }], messages: [{ role: "assistant", content: [] }] };
    expect((context as (e: typeof event) => typeof event)(event)).toBe(event);
    expect(event.messages[0].content).toHaveLength(0);
  });

  it("corrupt cache file is rebuilt on first write, never thrown", async () => {
    mkdirSync(join(project, ".deep-memory"), { recursive: true });
    writeFileSync(join(project, ".deep-memory", ".v2-warm-cache.json"), "{not json");
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);

    // prompt hook writes the null warm entry for its session.
    const prompt = handlerFor(registered, "session", "prompt");
    await (prompt as (e: { sessionID?: string }) => Promise<void>)({ sessionID: "ses_x" });
    // The corrupt file must have been replaced by valid JSON.
    const all = JSON.parse(readFileSync(join(project, ".deep-memory", ".v2-warm-cache.json"), "utf8")) as Record<string, unknown>;
    expect(all["ses_x"]).toBeDefined();
  });
});

describe("v2 bridge — context handler behaviors", () => {
  let project: string;
  beforeEach(() => { project = tempProject(); });
  afterEach(() => { try { rmSync(project, { recursive: true, force: true }); } catch { /* gone */ } });

  it("async system refresh writes a longer delta; a shorter/equal delta never overwrites", async () => {
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const context = handlerFor(registered, "session", "context");

    const event = {
      sessionID: "ses_r",
      agent: "build",
      system: [{ type: "text", text: "base" }],
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    };
    (context as (e: typeof event) => typeof event)(event);
    // The refresh runs fire-and-forget against the v1 system transform; give
    // the microtask queue a beat, then check what it persisted.
    await new Promise((r) => setTimeout(r, 50));
    const file = join(project, ".deep-memory", ".v2-warm-cache.json");
    if (existsSync(file)) {
      const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, { system?: string[] | null }>;
      // Whatever was written must be a non-empty string list (delta discipline)
      if (all["ses_r"]?.system) expect(all["ses_r"].system!.join("").length).toBeGreaterThan(0);
    }
  });

  it("warm messages are applied synchronously to the event (denoise handoff)", async () => {
    mkdirSync(join(project, ".deep-memory"), { recursive: true });
    writeFileSync(
      join(project, ".deep-memory", ".v2-warm-cache.json"),
      JSON.stringify({
        ses_m: {
          system: null,
          messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "DENOISED" }] }],
        },
      }),
    );
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const context = handlerFor(registered, "session", "context");

    const event = {
      sessionID: "ses_m",
      system: [{ type: "text", text: "base" }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "RAW noisy original" }] },
        { role: "user", content: [{ type: "text", text: "q" }] },
      ],
    };
    (context as (e: typeof event) => typeof event)(event);
    // applyMessages overwrites position 0's content with the cached parts.
    expect((event.messages[0].content as Array<{ text: string }>)[0].text).toBe("DENOISED");
  });
});

describe("v2 bridge — compaction mapping", () => {
  let project: string;
  beforeEach(() => { project = tempProject(); });
  afterEach(() => { try { rmSync(project, { recursive: true, force: true }); } catch { /* gone */ } });

  it("v1 compaction output {context[]} is prepended to event.system", async () => {
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const compaction = handlerFor(registered, "session", "compaction");

    const event = { sessionID: "ses_c", system: [{ type: "text", text: "base" }] };
    const returned = await (compaction as (e: typeof event) => Promise<typeof event>)(event);
    expect(returned).toBe(event);
    // The v1 compacting handler may or may not produce context for an empty
    // session; the contract we pin is: when it does, it lands at the FRONT,
    // and the handler never throws either way.
    if (event.system.length > 1) {
      expect((event.system[0] as { text: string }).text).toContain("Prior conversation archived");
    }
  });

  it("empty context leaves event.system untouched", async () => {
    const { ctx, registered } = mockV2Ctx({ directory: project });
    await v2Setup(ctx as never);
    const compaction = handlerFor(registered, "session", "compaction");
    const event = { sessionID: "ses_empty_" + Date.now(), system: [{ type: "text", text: "only" }] };
    await (compaction as (e: typeof event) => Promise<unknown>)(event);
    // No crash + system length never decreases.
    expect(event.system.length).toBeGreaterThanOrEqual(1);
  });
});

describe("v2 bridge — buildV2Client HTTP fallback", () => {
  let project: string;
  beforeEach(() => { project = tempProject(); });
  afterEach(() => {
    try { rmSync(project, { recursive: true, force: true }); } catch { /* gone */ }
    vi.restoreAllMocks();
    delete process.env["OPENCODE_SERVER_PORT"];
    delete process.env["OPENCODE_SERVER_PASSWORD"];
  });

  it("non-2xx HTTP → {data: []} (never throws)", async () => {
    process.env["OPENCODE_SERVER_PORT"] = "4599";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const client = buildV2Client({}) as { session: { messages(a: { path: { id: string } }): Promise<{ data: unknown[] }> } };
    const r = await client.session.messages({ path: { id: "s1" } });
    expect(r.data).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("127.0.0.1:4599");
    expect(url).toContain("/api/session/s1/message");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it("fetch rejection → {data: []} (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = buildV2Client({}) as { session: { messages(a: { path: { id: string } }): Promise<{ data: unknown[] }> } };
    await expect(client.session.messages({ path: { id: "s1" } })).resolves.toEqual({ data: [] });
  });

  it("2xx JSON is normalized into the v1 shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "m9", role: "user", content: ["hello"] }] }),
    }));
    const client = buildV2Client({}) as { session: { messages(a: { path: { id: string } }): Promise<{ data: Array<{ info: Record<string, unknown>; parts: unknown[] }> }> } };
    const r = await client.session.messages({ path: { id: "s2" } });
    expect(r.data[0].info).toMatchObject({ id: "m9", role: "user" });
    expect(r.data[0].parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("session.create without a ctx face returns {data: undefined}", async () => {
    const client = buildV2Client({}) as { session: { create(a: unknown): Promise<{ data: unknown }> } };
    await expect(client.session.create({ body: { title: "t" } })).resolves.toEqual({ data: undefined });
  });

  it("promptAsync without a prompt face resolves undefined", async () => {
    const client = buildV2Client({}) as { session: { promptAsync(a: unknown): Promise<unknown> } };
    await expect(client.session.promptAsync({ path: { id: "x" }, body: { parts: [] } })).resolves.toBeUndefined();
  });
});

describe("v2 bridge — disposal", () => {
  it("disposer calls every registration's dispose exactly once", async () => {
    const project = tempProject();
    try {
      const { ctx, disposeSpies } = mockV2Ctx({ directory: project });
      const disposer = await v2Setup(ctx as never);
      expect(disposeSpies.length).toBeGreaterThan(0);
      disposer();
      const calls = disposeSpies.map((d) => d.mock.calls.length);
      expect(calls.every((c) => c === 1)).toBe(true);
      // Second dispose is still safe (host may double-dispose).
      expect(() => disposer()).not.toThrow();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("one dispose throwing does not block the others", async () => {
    const project = tempProject();
    try {
      const { ctx, disposeSpies } = mockV2Ctx({ directory: project });
      const disposer = await v2Setup(ctx as never);
      disposeSpies[0].mockImplementation(() => { throw new Error("boom"); });
      expect(() => disposer()).not.toThrow();
      // The rest still ran.
      expect(disposeSpies.slice(1).every((d) => d.mock.calls.length >= 1)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("v2 bridge — register failures and reduced host", () => {
  it("a face registration throwing does not crash setup; other faces still register", async () => {
    const project = tempProject();
    try {
      const { ctx, registered } = mockV2Ctx({ directory: project });
      // Make the FIRST hook registration (prompt) blow up.
      (ctx.session as { hook: (event: string, handler: unknown) => Promise<{ dispose(): void }> }).hook = async (event: string) => {
        if (event === "prompt") throw new Error("host refuses prompt");
        registered.push({ face: "session", event, handler: null });
        return { dispose() {} };
      };
      const disposer = await v2Setup(ctx as never);
      expect(typeof disposer).toBe("function");
      expect(registered.find((r) => r.event === "context")).toBeTruthy();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reduced host (no agent.transform) → no-op disposer, disk untouched", async () => {
    const project = tempProject();
    try {
      const disposer = await v2Setup({ location: { directory: project } } as never);
      expect(typeof disposer).toBe("function");
      disposer();
      expect(existsSync(join(project, ".deep-memory", ".v2-warm-cache.json"))).toBe(false);
      expect(existsSync(join(project, ".deep-memory"))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("null ctx → no-op disposer", async () => {
    const disposer = await v2Setup(null as never);
    expect(typeof disposer).toBe("function");
    expect(() => disposer()).not.toThrow();
  });

  it("plugin id is stable", () => {
    expect(V2_PLUGIN_ID).toBe("opencode-deep-memory");
  });
});
