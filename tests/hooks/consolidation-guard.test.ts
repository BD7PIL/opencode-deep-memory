/**
 * Consolidation guard — the 2026-10-26 EL7 incident, pinned as regressions.
 *
 * That incident: a hardcoded `agent: "general"` in the prompt body that v2
 * engines silently drop (sub-sessions ran the host's default orchestrator),
 * four silent failure exits that never recorded anything, and a one-shot
 * pending consume that lost unfinished results — 9 doomed sub-sessions in 40
 * minutes. Every guard added since is exercised here against the real plugin
 * entry (hooks.event), not just the state helpers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { deepMemoryPlugin } from "../../src/index.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import {
  resolveConsolidationConfig,
  CONSOLIDATION_DEFAULTS,
} from "../../src/shared/consolidation-config.js";
import { probeAgent } from "../../src/shared/agent-probe.js";
import { withTempProject, mockHostClient } from "../helpers/mock-host.js";

type EventHooks = {
  event: (i: { event: { type: string; properties?: unknown } }) => Promise<void>;
};

function writeMemory(project: string, lines: number): string {
  const dir = path.join(project, ".deep-memory");
  fs.mkdirSync(dir, { recursive: true });
  const memPath = path.join(dir, "MEMORY.md");
  fs.writeFileSync(
    memPath,
    Array.from({ length: lines }, (_, i) => `- entry ${i} with enough technical detail to survive validation`).join("\n"),
    "utf8",
  );
  return memPath;
}

async function buildPlugin(
  project: string,
  client: unknown,
  options?: unknown,
): Promise<EventHooks> {
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
  const hooks = await deepMemoryPlugin(
    { directory: project, serverUrl: new URL("http://localhost:0"), client } as never,
    options as never,
  );
  return hooks as unknown as EventHooks;
}

async function idle(hooks: EventHooks, sessionID = "ses-parent", locationDirectory?: string): Promise<void> {
  await hooks.event({
    event: {
      type: "session.idle",
      properties: { sessionID, ...(locationDirectory ? { locationDirectory } : {}) },
    },
  });
}

/** Client whose agent-list face knows only the ids given. */
function clientWithAgents(ids: string[], extra: Record<string, unknown> = {}) {
  const client = mockHostClient(extra) as Record<string, unknown>;
  client["agent"] = { list: vi.fn().mockResolvedValue({ data: ids.map((id) => ({ id })) }) };
  return client;
}

const ERROR_MSGS = {
  data: [{ info: { role: "assistant", id: "m-err" }, parts: [{ type: "error", text: "provider 400" }] }],
};
/** A consolidation output that passes validateConsolidation against ~25 source lines. */
const VALID_TEXT = Array.from({ length: 20 }, (_, i) => `- merged entry ${i}`).join("\n");

afterEach(() => {
  vi.useRealTimers();
});

describe("consolidation config resolution", () => {
  it("falls back to the documented defaults", () => {
    expect(resolveConsolidationConfig(undefined, {})).toEqual(CONSOLIDATION_DEFAULTS);
  });

  it("plugin options override every key", () => {
    expect(
      resolveConsolidationConfig(
        { consolidation: { enabled: false, agent: "build", maxFailures: 5, pendingTimeoutMs: 60_000 } },
        {},
      ),
    ).toEqual({ enabled: false, agent: "build", maxFailures: 5, pendingTimeoutMs: 60_000 });
  });

  it("env vars work without options (the v2-host path) and falsey strings disable", () => {
    expect(
      resolveConsolidationConfig(undefined, {
        DEEP_MEMORY_CONSOLIDATION: "off",
        DEEP_MEMORY_CONSOLIDATION_AGENT: "executor",
        DEEP_MEMORY_CONSOLIDATION_MAX_FAILURES: "7",
        DEEP_MEMORY_CONSOLIDATION_PENDING_TIMEOUT_MS: "120000",
      }),
    ).toEqual({ enabled: false, agent: "executor", maxFailures: 7, pendingTimeoutMs: 120_000 });
    expect(
      resolveConsolidationConfig(undefined, { DEEP_MEMORY_CONSOLIDATION: "1" }).enabled,
      // anything non-falsey enables
    ).toBe(true);
  });

  it("clamps numbers into sane ranges instead of trusting them", () => {
    expect(resolveConsolidationConfig({ consolidation: { maxFailures: 0 } }, {}).maxFailures).toBe(1);
    expect(resolveConsolidationConfig({ consolidation: { maxFailures: 1000 } }, {}).maxFailures).toBe(100);
    expect(resolveConsolidationConfig({ consolidation: { pendingTimeoutMs: 1 } }, {}).pendingTimeoutMs).toBe(30_000);
    expect(
      resolveConsolidationConfig({ consolidation: { agent: "   " } }, {}).agent,
    ).toBe(CONSOLIDATION_DEFAULTS.agent);
  });
});

describe("consolidation state guards", () => {
  it("counts failures and resets them (and only them) on success", () => {
    const state = createPluginState();
    expect(state.consolidationFailures()).toBe(0);
    expect(state.recordConsolidationFailure()).toBe(1);
    expect(state.recordConsolidationFailure()).toBe(2);
    state.recordConsolidationDone(40);
    expect(state.consolidationFailures()).toBe(0);
  });

  it("peek is non-destructive; consume is; setAt survives persist/restore", async () => {
    await withTempProject(async (project) => {
      const state = createPluginState();
      state.setPendingConsolidation("p1", { subSessionID: "sub-1", memMtime: 42 });
      expect(state.peekPendingConsolidation("p1")?.subSessionID).toBe("sub-1");
      expect(state.peekPendingConsolidation("p1")?.setAt).toBeGreaterThan(0);
      // still there after peek
      expect(state.peekPendingConsolidation("p1")).toBeDefined();
      state.persistPendingConsolidation(project);

      const restored = createPluginState();
      expect(restored.restorePendingConsolidation(project)).toBe(true);
      const entry = restored.peekPendingConsolidation("p1");
      expect(entry?.subSessionID).toBe("sub-1");
      expect(entry?.memMtime).toBe(42);
      expect(typeof entry?.setAt).toBe("number");

      restored.consumePendingConsolidation("p1");
      restored.persistPendingConsolidation(project);
      expect(fs.existsSync(path.join(project, ".pending-consolidation.json"))).toBe(false);
    });
  });
});

describe("probeAgent", () => {
  it("finds ids in object lists via the agent.list face", async () => {
    const client = { agent: { list: async () => ({ data: [{ id: "build" }, { id: "general" }] }) } };
    await expect(probeAgent(client, "general")).resolves.toBe(true);
    await expect(probeAgent(client, "foreman")).resolves.toBe(false);
  });

  it("also accepts plain string lists and the app.agents alias face", async () => {
    await expect(probeAgent({ agent: { list: async () => ({ data: ["general"] }) } }, "general")).resolves.toBe(true);
    await expect(probeAgent({ app: { agents: async () => [{ id: "general" }] } }, "general")).resolves.toBe(true);
  });

  it("never blocks on uncertainty: no face, throwing face, or empty payload → null", async () => {
    await expect(probeAgent({}, "general")).resolves.toBeNull();
    await expect(probeAgent({ agent: { list: async () => { throw new Error("boom"); } } }, "general")).resolves.toBeNull();
    await expect(probeAgent({ agent: { list: async () => ({ data: [] }) } }, "general")).resolves.toBeNull();
    await expect(probeAgent({ agent: { list: async () => ({ data: [{ nope: 1 }] }) } }, "general")).resolves.toBeNull();
  });
});

describe("idle consolidation guards (through the plugin entry)", () => {
  it("memoizes per project directory: two projects never share one hooks instance", async () => {
    await withTempProject(async (projectA) => {
      await withTempProject(async (projectB) => {
        delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
        const build = (directory: string) =>
          deepMemoryPlugin({
            directory,
            serverUrl: new URL("http://localhost:0"),
            client: clientWithAgents(["general"]),
          } as never) as Promise<unknown>;

        const a1 = await build(projectA);
        const b1 = await build(projectB);
        const a2 = await build(projectA);
        // Same directory → same instance (host may load the module twice)…
        expect(a2).toBe(a1);
        // …but a different location must get its own projectPath/state/client,
        // otherwise consolidation runs against the wrong project's MEMORY.md.
        expect(b1).not.toBe(a1);
        delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
      });
    });
  });

  it("ignores idles that belong to another project's location (v2 broadcast)", async () => {
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      const client = clientWithAgents(["general"]);
      const hooks = await buildPlugin(project, client);
      // Foreign location: v2 broadcasts every session event to every instance,
      // so this instance must not consolidate its own memory for someone else's turn.
      await idle(hooks, "ses-foreign", "/tmp/some-other-project");
      expect((client as { session: { create: ReturnType<typeof vi.fn> } }).session.create).not.toHaveBeenCalled();
      // Own location still works.
      await idle(hooks, "ses-own", project);
      expect((client as { session: { create: ReturnType<typeof vi.fn> } }).session.create).toHaveBeenCalledTimes(1);
    });
    // No location at all (v1 hosts) keeps the legacy behaviour.
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      const client = clientWithAgents(["general"]);
      const hooks = await buildPlugin(project, client);
      await idle(hooks, "ses-legacy");
      expect((client as { session: { create: ReturnType<typeof vi.fn> } }).session.create).toHaveBeenCalledTimes(1);
    });
  });

  it("concurrent setups for one project yield ONE instance (no duplicate subscriptions)", async () => {
    await withTempProject(async (project) => {
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
      const build = () =>
        deepMemoryPlugin({
          directory: project,
          serverUrl: new URL("http://localhost:0"),
          client: clientWithAgents(["general"]),
        } as never);
      // Two hosts racing to set up the same location: building is async, so a
      // finished-only memo would hand out two live instances → every idle would
      // spawn two consolidations.
      const [a, b] = await Promise.all([build(), build()]);
      const c = await build();
      expect(a).toBe(b);
      expect(c).toBe(a);
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
    });
  });

  it("duplicate delivery of ONE idle spawns only once", async () => {
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      // Slow probe so both invocations would pass the cooldown check under the
      // old check-then-act order.
      const client = mockHostClient({ messages: [] }) as Record<string, unknown>;
      (client as { agent: Record<string, unknown> }).agent = {
        list: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { data: [{ id: "general" }] };
        }),
      };
      const hooks = await buildPlugin(project, client);
      await Promise.all([idle(hooks, "ses-dup"), idle(hooks, "ses-dup")]);
      expect((client as { session: { create: ReturnType<typeof vi.fn> } }).session.create).toHaveBeenCalledTimes(1);
    });
  });

  it("disabled via config: never spawns", async () => {
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      const client = clientWithAgents(["general"]);
      const hooks = await buildPlugin(project, client, { consolidation: { enabled: false } });
      await idle(hooks);
      expect((client as { session: { create: ReturnType<typeof vi.fn> } }).session.create).not.toHaveBeenCalled();
    });
  });

  it("agent missing on host: no spawn, and the decision repeats silently (logged once)", async () => {
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      const client = clientWithAgents(["build", "foreman"]);
      const hooks = await buildPlugin(project, client);
      await idle(hooks);
      await idle(hooks);
      const c = (client as { session: { create: ReturnType<typeof vi.fn> } }).session.create;
      expect(c).not.toHaveBeenCalled();
      // The attempt is recorded before the (async) probe, so the immediate
      // repeat idles out on the cooldown instead of re-probing every tick.
      expect((client as { agent: { list: ReturnType<typeof vi.fn> } }).agent.list).toHaveBeenCalledTimes(1);
    });
  });

  it("spawn rides the session.create agent+model channel (the v2 fix), not just the prompt body", async () => {
    await withTempProject(async (project) => {
      writeMemory(project, 25);
      const client = clientWithAgents(["general"], {
        messages: [],
      });
      // config.get → fallback model, so bestModel() resolves and the create
      // body must carry it alongside the agent.
      (client as { config: { get: ReturnType<typeof vi.fn> } }).config.get.mockResolvedValue({
        data: { model: "reeve/free" },
      });
      const hooks = await buildPlugin(project, client);
      await idle(hooks);
      const c = (client as { session: { create: ReturnType<typeof vi.fn> } }).session.create;
      expect(c).toHaveBeenCalledTimes(1);
      const body = c.mock.calls[0][0].body as { agent?: string; model?: { providerID: string; modelID: string } };
      expect(body.agent).toBe("general");
      expect(body.model).toEqual({ providerID: "reeve", modelID: "free" });
    });
  });

  it("give-up: three consecutive LLM errors stop all further spawns until restart", async () => {
    await withTempProject(async (project) => {
      vi.useFakeTimers();
      writeMemory(project, 25);
      let spawnCount = 0;
      const client = clientWithAgents(["general"]);
      const c = (client as { session: { create: ReturnType<typeof vi.fn> } }).session.create;
      c.mockImplementation(async () => {
        spawnCount += 1;
        return { data: { id: `sub-${spawnCount}` } };
      });
      (client as { session: { messages: ReturnType<typeof vi.fn> } }).session.messages.mockResolvedValue(ERROR_MSGS);

      const hooks = await buildPlugin(project, client);
      // spawn → error → spawn → error → spawn → error (budget exhausted)
      await idle(hooks);
      await idle(hooks);
      await vi.advanceTimersByTimeAsync(61_000);
      await idle(hooks);
      await idle(hooks);
      await vi.advanceTimersByTimeAsync(61_000);
      await idle(hooks);
      await idle(hooks);
      expect(c).toHaveBeenCalledTimes(3);

      // budget spent: the next idle must not spawn, even though the memory
      // still "needs consolidation" by line count.
      await vi.advanceTimersByTimeAsync(61_000);
      await idle(hooks);
      await idle(hooks);
      expect(c).toHaveBeenCalledTimes(3);
      expect(fs.existsSync(path.join(project, ".pending-consolidation.json"))).toBe(false);
    });
  });

  it("re-poll: an unfinished sub-session keeps its pending entry; timeout consumes + counts", async () => {
    await withTempProject(async (project) => {
      vi.useFakeTimers();
      writeMemory(project, 25);
      const client = clientWithAgents(["general"]);
      const pendingFile = path.join(project, ".pending-consolidation.json");
      (client as { session: { messages: ReturnType<typeof vi.fn> } }).session.messages.mockResolvedValue({
        // last message is the user prompt itself — sub-session still running
        data: [{ info: { role: "user", id: "m0" }, parts: [{ type: "text", text: "consolidate..." }] }],
      });

      const hooks = await buildPlugin(project, client, { consolidation: { pendingTimeoutMs: 30_000 } });
      await idle(hooks); // spawn (messages not consulted on the spawn path)
      const c = (client as { session: { create: ReturnType<typeof vi.fn> } }).session.create;
      expect(c).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(pendingFile)).toBe(true);

      await idle(hooks); // sub-session unfinished → pending kept, re-polled
      expect(fs.existsSync(pendingFile)).toBe(true);
      expect(c).toHaveBeenCalledTimes(1); // no respawn while pending

      await vi.advanceTimersByTimeAsync(31_000);
      await idle(hooks); // aged → consume + one failure
      expect(fs.existsSync(pendingFile)).toBe(false);

      // one failure < maxFailures: the next cycle spawns again
      (client as { session: { messages: ReturnType<typeof vi.fn> } }).session.messages.mockResolvedValue({ data: [] });
      await vi.advanceTimersByTimeAsync(61_000);
      await idle(hooks);
      expect(c).toHaveBeenCalledTimes(2);
    });
  });

  it("success path: applies text, writes the .bak backup, and clears the pending entry", async () => {
    await withTempProject(async (project) => {
      vi.useFakeTimers();
      const memPath = writeMemory(project, 25);
      const original = fs.readFileSync(memPath, "utf8");
      const client = clientWithAgents(["general"]);
      (client as { session: { messages: ReturnType<typeof vi.fn> } }).session.messages.mockResolvedValue({
        data: [{ info: { role: "assistant", id: "m1" }, parts: [{ type: "text", text: VALID_TEXT }] }],
      });

      const hooks = await buildPlugin(project, client);
      await idle(hooks); // spawn
      await idle(hooks); // apply
      expect(fs.readFileSync(memPath, "utf8")).toBe(VALID_TEXT);
      expect(fs.existsSync(memPath.replace("MEMORY.md", "MEMORY.bak.md"))).toBe(true);
      expect(fs.readFileSync(memPath.replace("MEMORY.md", "MEMORY.bak.md"), "utf8")).toBe(original);
      expect(fs.existsSync(path.join(project, ".pending-consolidation.json"))).toBe(false);
    });
  });
});
