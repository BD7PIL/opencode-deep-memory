/**
 * Plugin assembly test — smoke's structural assertions migrated into vitest
 * (batch 0.15.1, plan item P3-18).
 *
 * The built-dist smoke script stays as the release gate; this file pins the
 * same shapes against src/ on every `npm test`, plus the store → search →
 * system-injection positive loop, so hook-shape regressions fail in CI
 * without a build step.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { deepMemoryPlugin } from "../src/index.js";
import { buildV2Client } from "../src/v2/entry.js";
import { withTempProject } from "./helpers/mock-host.js";

interface HooksLike {
  "chat.params": (i: unknown, o: unknown) => Promise<void>;
  "experimental.chat.system.transform": (i: unknown, o: { system: string[] }) => Promise<void>;
  "experimental.chat.messages.transform": (i: unknown, o: unknown) => Promise<void>;
  event: (i: unknown) => Promise<void>;
  tool: Record<string, { execute(args: Record<string, unknown>, ctx?: unknown): Promise<unknown> }>;
}

async function buildHooks(project: string): Promise<HooksLike> {
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
  return (await deepMemoryPlugin({
    directory: project,
    serverUrl: new URL("http://localhost:0"),
    client: buildV2Client({}),
  } as never)) as unknown as HooksLike;
}

const chatParamsInput = {
  sessionID: "asm-1",
  agent: "build",
  model: { id: "m", providerID: "p" },
  provider: {},
  message: { role: "user" },
};
const chatParamsOutput = { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} };

describe("plugin assembly (hook registration shape)", () => {
  it("exposes every hook face the v1 host expects, with 7 tools", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      expect(typeof hooks["chat.params"]).toBe("function");
      expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
      expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function");
      expect(typeof hooks.event).toBe("function");
      const toolNames = Object.keys(hooks.tool).sort();
      expect(toolNames).toHaveLength(7);
      expect(toolNames).toContain("deep_expand");
      expect(toolNames).toContain("context_compress");
      expect(toolNames).toContain("memory_topic");
    });
  });

  it("v1 tool calls work without scope/type args (default project scope)", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      await expect(hooks.tool.memory_store.execute({ content: "assembly smoke entry" })).resolves.toBeTruthy();
      await expect(hooks.tool.memory_search.execute({ query: "assembly smoke" })).resolves.toMatch(/assembly smoke entry/);
    });
  });
});

describe("store → search → system injection positive loop", () => {
  it("MEMORY.md content reaches the system payload only after a store (mtime cache)", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      await hooks["chat.params"](chatParamsInput, chatParamsOutput);

      const sys1 = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "asm-1", model: { id: "m" } }, sys1);
      // V4 pushes exactly ONE frozen fragment.
      expect(sys1.system).toHaveLength(1);
      expect(sys1.system[0]).toContain("<deep-memory-stable>");
      expect(sys1.system[0]).toContain("<tool-hint>");
      expect(sys1.system[0]).toContain("memory_search");
      expect(sys1.system[0]).not.toContain("<deep-memory-volatile>");

      // Byte-stable across turns while MEMORY.md is unchanged.
      const sys2 = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "asm-1", model: { id: "m" } }, sys2);
      expect(sys2.system[0]).toBe(sys1.system[0]);

      // Store → cache invalidated → content appears in the next payload.
      await hooks.tool.memory_store.execute({
        content: "assembly loop uses capture-time caps",
        type: "decision",
        scope: "project",
      });
      const sys3 = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "asm-1", model: { id: "m" } }, sys3);
      expect(sys3.system[0]).toContain("capture-time caps");
      expect(sys3.system[0]).not.toBe(sys1.system[0]);

      // search finds what the loop stored.
      const search = (await hooks.tool.memory_search.execute({ query: "capture-time", scope: "project", limit: 5 })) as string;
      expect(typeof search).toBe("string");
      expect(search).toContain("capture-time");
    });
  });

  it("context_compress schedules a compression request", async () => {
    await withTempProject(async (project) => {
      const hooks = await buildHooks(project);
      const result = await hooks.tool.context_compress.execute({ keep_recent: 5, summary: "Test summary of old content" });
      expect(JSON.stringify(result)).toContain("Compression scheduled");
    });
  });
});

describe("storage layout invariants", () => {
  it("no dream/distill/legacy artifacts; project layout is .deep-memory/", async () => {
    await withTempProject(async (project, globalRoot) => {
      const hooks = await buildHooks(project);
      await hooks.tool.memory_store.execute({ content: "layout probe entry", scope: "project" });
      const dm = path.join(project, ".deep-memory");
      expect(fs.existsSync(dm)).toBe(true);
      expect(fs.existsSync(path.join(dm, "MEMORY.md"))).toBe(true);
      expect(fs.existsSync(path.join(dm, ".schedule.json"))).toBe(false);
      expect(fs.existsSync(path.join(dm, "checkpoint.raw.json"))).toBe(false);
      expect(fs.existsSync(path.join(globalRoot, "projects"))).toBe(false);
    });
  });
});
