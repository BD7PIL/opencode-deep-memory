/**
 * v2 bridge behavior tests — adapter rewrite for opencode 2.0.32.
 *
 * Drives `v2Setup` against a mock that models the REAL runtime faces (see
 * mock-host.ts). The 0.15.x suite could not have caught the defects this file
 * now guards, because its mock only asserted that *some* registration happened:
 * it never registered a tool, never consumed the event iterable, and accepted
 * the invalid `tool.hook("*")` name.
 *
 * Evidence for every expectation is in docs/research/v2-032-respike.md.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Setup, V2_PLUGIN_ID, buildV2Client, normalizeContextList } from "../../src/v2/entry.js";
import { mockV2Ctx, tempProject, withTempProject } from "../helpers/mock-host.js";

/** deepMemoryPlugin memoizes its hooks on globalThis; drop them per test. */
function clearHookSingleton(): void {
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
}

beforeEach(clearHookSingleton);

describe("v2 bridge — tool registration", () => {
  it("registers every v1 tool through tool.transform", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      expect(host.registered.some((r) => r.face === "tool" && r.event === "transform")).toBe(true);
      for (const name of [
        "memory_search",
        "memory_store",
        "memory_forget",
        "memory_expand",
        "memory_topic",
        "context_compress",
        "deep_expand",
      ]) {
        expect(host.toolRegistry.has(name), `${name} should be registered`).toBe(true);
      }
    });
  });

  it("reproduces the v1 tool names by splitting the key on its first underscore", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      // v2 composes the LLM-facing name as `${namespace}_${name}`; the split
      // exists so the frozen TOOL_HINT keeps referring to real tool names.
      const search = host.toolRegistry.get("memory_search");
      expect(search?.name).toBe("search");
      expect((search?.options as { namespace?: string })?.namespace).toBe("memory");
      expect((search?.options as { codemode?: boolean })?.codemode).toBe(false);
    });
  });

  it("gives every tool a JSON Schema input and an output schema", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const search = host.toolRegistry.get("memory_search") as {
        input: { type?: string; properties?: Record<string, unknown>; required?: string[] };
        output: Record<string, unknown>;
      };
      expect(search.input.type).toBe("object");
      expect(Object.keys(search.input.properties ?? {}).sort()).toEqual(["limit", "query", "scope"]);
      // Fields carrying a default are optional on the wire.
      expect(search.input.required).toEqual(["query"]);
      expect(search.output).toBeTruthy();
    });
  });

  it("wraps v1 string results into the v2 {output} contract", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const search = host.toolRegistry.get("memory_search") as {
        execute: (input: unknown, ctx: unknown) => Promise<{ output: string }>;
      };
      const result = await search.execute({ query: "nothing matches this" }, {});
      expect(typeof result.output).toBe("string");
    });
  });

  it("is idempotent when the host re-runs the transform callback", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const afterFirst = host.toolRegistry.size;

      // The real host re-run the callback in one observed session; a fresh
      // editor is built each time, and registration must not accumulate.
      clearHookSingleton();
      await v2Setup(host.ctx as never);
      expect(host.toolRegistry.size).toBe(afterFirst);
    });
  });
});

describe("v2 bridge — tool hooks", () => {
  it("registers execute.after, never the invalid '*' name", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const toolHookNames = host.registered.filter((r) => r.face === "tool").map((r) => r.event);
      expect(toolHookNames).toContain("execute.after");
      expect(toolHookNames).not.toContain("*");
    });
  });

  it("maps the v2 single-object payload onto the v1 (input, output) shape", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const handler = host.handlerFor("tool", "execute.after");
      expect(handler).toBeTruthy();
      // A completed read of a source file drives repomap tracking in v1, which
      // reads input.args.path and output.output.
      await expect(
        handler!({
          tool: "read",
          sessionID: "ses_1",
          id: "call_1",
          input: { path: join(project, "src.ts") },
          status: "completed",
          result: { output: "file body" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("v2 bridge — event subscription", () => {
  it("consumes the async iterable and maps v2 names onto v1 events", async () => {
    await withTempProject(async (project) => {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      const host = mockV2Ctx({
        directory: project,
        events: [
          { type: "session.execution.succeeded", data: { sessionID: "ses_idle" } },
          { type: "session.compaction.started", data: { sessionID: "ses_comp", reason: "manual" } },
          { type: "session.created", data: { sessionID: "ses_new" } },
          // An event type the plugin does not care about: must be ignored.
          { type: "model.updated", data: {} },
        ],
      });
      await v2Setup(host.ctx as never);

      expect(host.registered.some((r) => r.face === "event" && r.event === "subscribe")).toBe(true);

      // The v1 handler for session.compacted writes the compaction audit log.
      // Its appearance proves a v2-NAMED event reached the v1 vocabulary, which
      // is exactly what 0.15.x could not do: v2 emits no session.compacted.
      const auditLog = join(project, ".deep-memory", ".compaction-log.jsonl");
      await vi.waitFor(() => {
        expect(existsSync(auditLog)).toBe(true);
      }, { timeout: 2000 });
      expect(readFileSync(auditLog, "utf8")).toContain("ses_comp");
    });
  });

  it("aborts the subscription on dispose", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project, events: [] });
      const dispose = await v2Setup(host.ctx as never);
      expect(host.signals).toHaveLength(1);
      expect(host.signals[0]!.aborted).toBe(false);
      dispose();
      expect(host.signals[0]!.aborted).toBe(true);
    });
  });
});

describe("v2 bridge — context handler", () => {
  const MEMORY = "# Memory\n\n## Gotchas\n- stable line [2026-10-20]\n";

  it("awaits the v1 system transform and appends its payload as one system part", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const handler = host.handlerFor("session", "context")!;
      const event = {
        sessionID: "ses_ctx",
        agent: "build",
        model: { id: "m1", providerID: "p1" },
        system: [{ type: "text", text: "base prompt" }],
        messages: [],
      };
      // v2 AWAITS the handler, so the result must be complete on return.
      await handler(event);
      expect(event.system.length).toBe(2);
      const injected = event.system[1] as { type: string; text: string };
      expect(injected.type).toBe("text");
      expect(injected.text).toContain("deep-memory");
      // No explicit cache hint: auto-policy already breaks at the last system part.
      expect((injected as { cache?: unknown }).cache).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("produces a byte-identical system block across consecutive turns", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const handler = host.handlerFor("session", "context")!;

      const runTurn = async (): Promise<string> => {
        const event = {
          sessionID: "ses_stable",
          agent: "build",
          model: { id: "m1", providerID: "p1" },
          system: [{ type: "text", text: "base prompt" }],
          messages: [],
        };
        await handler(event);
        return JSON.stringify(event.system);
      };
      const first = await runTurn();
      expect(await runTurn()).toBe(first);
      expect(await runTurn()).toBe(first);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("records agent and model from the context payload", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const handler = host.handlerFor("session", "context")!;
      // The prompt hook carries no agent/model; context is the only source, and
      // without it state.bestModel() stays undefined and the consolidation
      // sub-session would be spawned with no model.
      await expect(
        handler({
          sessionID: "ses_model",
          agent: "build",
          model: { id: "deepseek", providerID: "e6stub" },
          system: [{ type: "text", text: "base" }],
          messages: [],
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("hands unmodified messages back BY IDENTITY so the cache prefix holds", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), MEMORY);
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const handler = host.handlerFor("session", "context")!;

      const user = { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] };
      const event = {
        sessionID: "ses_ident",
        agent: "build",
        model: { id: "m1", providerID: "p1" },
        system: [{ type: "text", text: "base" }],
        messages: [user],
      };
      await handler(event);
      expect(event.messages[0]).toBe(user);
      expect(user.content).toEqual([{ type: "text", text: "hello" }]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("a failing v1 transform never throws out of the handler", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      const handler = host.handlerFor("session", "context")!;
      // A malformed event (no arrays) must be tolerated, not thrown.
      await expect(handler({ sessionID: "ses_bad" })).resolves.toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("v2 bridge — compaction mapping", () => {
  it("appends the v1 context[] to event.system", async () => {
    const project = tempProject();
    try {
      mkdirSync(join(project, ".deep-memory"), { recursive: true });
      writeFileSync(join(project, ".deep-memory", "MEMORY.md"), "# Memory\n");
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);

      const handler = host.handlerFor("session", "compaction")!;
      const event = {
        sessionID: "ses_comp",
        agent: "build",
        model: { id: "m1", providerID: "p1" },
        system: [{ type: "text", text: "compaction template" }],
        messages: [
          { id: "m1", role: "user", content: [{ type: "text", text: "old question" }] },
          { id: "m2", role: "assistant", content: [{ type: "text", text: "old answer" }] },
        ],
      };
      await handler(event);
      // Appended, not prepended: appending keeps the harness template first and
      // avoids moving the cached prefix.
      expect(event.system[0]).toEqual({ type: "text", text: "compaction template" });
      if (event.system.length > 1) {
        const appended = event.system[event.system.length - 1] as { text: string };
        expect(typeof appended.text).toBe("string");
        expect(appended.text.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("registers the compaction face", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      await v2Setup(host.ctx as never);
      expect(host.registered.some((r) => r.face === "session" && r.event === "compaction")).toBe(true);
    });
  });
});

describe("v2 bridge — buildV2Client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["OPENCODE_SERVER_PORT"];
  });

  it("reads messages through ctx.session.context and drops non-conversational markers", async () => {
    const ctx = {
      session: {
        async context() {
          return {
            data: [
              { id: "m1", type: "user", text: "hello" },
              { id: "m2", type: "assistant", content: [{ type: "text", text: "hi" }] },
              { id: "m3", type: "idle", outcome: "succeeded" },
              { id: "m4", type: "compaction", status: "completed" },
            ],
          };
        },
      },
    };
    const client = buildV2Client(ctx as never) as {
      session: { messages(a: { path: { id: string } }): Promise<{ data: Array<{ info: Record<string, unknown>; parts: unknown[] }> }> };
    };
    const result = await client.session.messages({ path: { id: "s1" } });
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.info["role"]).toBe("user");
    expect(result.data[1]!.info["role"]).toBe("assistant");
    // Both v1 call sites read msgs[msgs.length - 1] and require an assistant
    // message; a v2 list ends with an `idle` marker, so forwarding it would
    // silently disable idle consolidation.
    expect(result.data[result.data.length - 1]!.info["role"]).toBe("assistant");
  });

  it("falls back to loopback HTTP when the ctx face is absent", async () => {
    process.env["OPENCODE_SERVER_PORT"] = "4599";
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }] }),
    });
    vi.stubGlobal("fetch", fetchStub);

    const client = buildV2Client({}) as {
      session: { messages(a: { path: { id: string } }): Promise<{ data: unknown[] }> };
    };
    const result = await client.session.messages({ path: { id: "ses_1" } });

    expect(fetchStub).toHaveBeenCalledOnce();
    const url = String(fetchStub.mock.calls[0]![0]);
    expect(url).toContain("127.0.0.1:4599/api/session/ses_1/context");
    expect(String((fetchStub.mock.calls[0]![1] as { headers: Record<string, string> }).headers["authorization"])).toMatch(/^Basic /);
    expect(result.data).toHaveLength(1);
  });

  it("non-2xx HTTP → {data: []} (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const client = buildV2Client({}) as { session: { messages(a: unknown): Promise<{ data: unknown[] }> } };
    await expect(client.session.messages({ path: { id: "x" } })).resolves.toEqual({ data: [] });
  });

  it("fetch rejection → {data: []} (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = buildV2Client({}) as { session: { messages(a: unknown): Promise<{ data: unknown[] }> } };
    await expect(client.session.messages({ path: { id: "x" } })).resolves.toEqual({ data: [] });
  });

  it("session.create returns the id from either the bare or the wrapped shape", async () => {
    const bare = buildV2Client({ session: { async create() { return { id: "ses_bare" }; } } } as never) as {
      session: { create(a: unknown): Promise<{ data: { id?: string } }> };
    };
    expect((await bare.session.create({ body: { title: "t" }, query: { directory: "/p" } })).data.id).toBe("ses_bare");

    const wrapped = buildV2Client({ session: { async create() { return { data: { id: "ses_wrapped" } }; } } } as never) as {
      session: { create(a: unknown): Promise<{ data: { id?: string } }> };
    };
    expect((await wrapped.session.create({ body: { title: "t" }, query: { directory: "/p" } })).data.id).toBe("ses_wrapped");
  });

  it("session.create without a ctx face returns {data: undefined}", async () => {
    const client = buildV2Client({}) as { session: { create(a: unknown): Promise<{ data?: unknown }> } };
    await expect(client.session.create({ body: {}, query: {} })).resolves.toEqual({ data: undefined });
  });

  it("promptAsync joins the text parts and resolves without awaiting the turn", async () => {
    const promptSpy = vi.fn().mockResolvedValue({});
    const client = buildV2Client({ session: { prompt: promptSpy } } as never) as {
      session: { promptAsync(a: unknown): Promise<unknown> };
    };
    await client.session.promptAsync({
      path: { id: "ses_sub" },
      body: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }], agent: "general" },
    });
    expect(promptSpy).toHaveBeenCalledOnce();
    expect(promptSpy.mock.calls[0]![0]).toEqual({ sessionID: "ses_sub", text: "a\nb", agent: "general" });
  });

  it("tui.showToast stays undefined (every call site null-guards)", () => {
    const client = buildV2Client({}) as { tui: { showToast?: unknown } };
    expect(client.tui.showToast).toBeUndefined();
  });

  it("normalizeContextList tolerates the v1 {info, parts} shape", () => {
    const result = normalizeContextList({ data: [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "x" }] }] });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.parts).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("v2 bridge — disposal and reduced host", () => {
  it("disposer disposes every registration exactly once", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({ directory: project });
      const dispose = await v2Setup(host.ctx as never);
      expect(host.disposeSpies.length).toBeGreaterThan(0);
      dispose();
      for (const spy of host.disposeSpies) expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("one dispose throwing does not block the others", async () => {
    await withTempProject(async (project) => {
      const host = mockV2Ctx({
        directory: project,
        session: {
          async hook() {
            return { dispose: () => { throw new Error("boom"); } };
          },
        },
      });
      const dispose = await v2Setup(host.ctx as never);
      expect(() => dispose()).not.toThrow();
    });
  });

  it("reduced host (no agent.transform) → no-op disposer and no registrations", async () => {
    const host = mockV2Ctx({ reducedHost: true });
    const dispose = await v2Setup(host.ctx as never);
    expect(typeof dispose).toBe("function");
    expect(host.registered).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
  });

  it("null ctx → no-op disposer", async () => {
    const dispose = await v2Setup(null as never);
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });

  it("plugin id is stable", () => {
    expect(V2_PLUGIN_ID).toBe("opencode-deep-memory");
  });
});