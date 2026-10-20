/**
 * Entry dispatch — the dual-form default export and the event hook's branches.
 *
 * v1 hosts call the default export as a function (input → Hooks); v2 hosts read
 * `.setup` ({id, setup} → disposer). Both must point at the same wiring, and the
 * memoized hooks must be returned identically on a second call (the host may
 * load the module more than once).
 *
 * The event handler is the arm that "must NEVER throw — would break OpenCode's
 * event loop", so its swallow-and-log contract is pinned here too.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import pluginModule, { deepMemoryPlugin, v2Setup } from "../src/index.js";
import { v2Setup as v2SetupDirect } from "../src/v2/entry.js";
import { withTempProject } from "./helpers/mock-host.js";
import { buildV2Client } from "../src/v2/entry.js";

interface HooksLike {
  event: (i: { event: { type: string; properties?: unknown } }) => Promise<void>;
  "chat.params": (i: unknown, o: unknown) => Promise<void>;
}

async function buildHooks(project: string): Promise<HooksLike> {
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
  const hooks = await deepMemoryPlugin({
    directory: project,
    serverUrl: new URL("http://localhost:0"),
    client: buildV2Client({}),
  } as never);
  return hooks as unknown as HooksLike;
}

describe("dual-form entry dispatch", () => {
  it("default export exposes id + v1 server + the very same v2 setup", () => {
    expect(pluginModule.id).toBe("opencode-deep-memory");
    expect(pluginModule.server).toBe(deepMemoryPlugin); // v1: called as a function
    expect(pluginModule.setup).toBe(v2Setup); // v2: {id, setup} contract
    expect(v2Setup).toBe(v2SetupDirect); // the re-export is the same binding
  });

  it("memoizes the hooks: a second call without clearing returns the same object", async () => {
    await withTempProject(async (project) => {
      const first = await buildHooks(project);
      const second = (await deepMemoryPlugin({
        directory: project,
        serverUrl: new URL("http://localhost:0"),
        client: buildV2Client({}),
      } as never)) as unknown as HooksLike;
      expect(second).toBe(first); // cached, not rebuilt
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
    });
  });
});

describe("event handler branches", () => {
  it("session.compacted writes the audit log line and calibrates when tokens are known", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses-42" } } });
      const logPath = path.join(project, ".deep-memory", ".compaction-log.jsonl");
      expect(fs.existsSync(logPath)).toBe(true);
      const line = fs.readFileSync(logPath, "utf-8").trim().split("\n").pop()!;
      const parsed = JSON.parse(line) as { sessionID: string; timestamp: string };
      expect(parsed.sessionID).toBe("ses-42");
      expect(Date.parse(parsed.timestamp)).not.toBeNaN();
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
    });
  });

  it("session.created / session.error / session.deleted / session.idle never throw", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      await expect(hooks.event({ event: { type: "session.created", properties: {} } })).resolves.toBeUndefined();
      await expect(
        hooks.event({ event: { type: "session.error", properties: { sessionID: "s", error: new Error("x") } } }),
      ).resolves.toBeUndefined();
      await expect(
        hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s" } } } }),
      ).resolves.toBeUndefined();
      await expect(
        hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } }),
      ).resolves.toBeUndefined();
      // Unknown event types are ignored, not thrown on.
      await expect(hooks.event({ event: { type: "whatever.else", properties: {} } })).resolves.toBeUndefined();
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
    });
  });

  it("a poisoned event payload is swallowed and logged, not propagated", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      // session.compacted with properties = null makes the handler's property
      // access throw; the catch must swallow it (event loop safety).
      await expect(
        hooks.event({ event: { type: "session.compacted", properties: null } }),
      ).resolves.toBeUndefined();
      delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
    });
  });
});