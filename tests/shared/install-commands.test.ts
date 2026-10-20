/**
 * install-commands — drives the BUILT dist, like the real host does.
 *
 * The source directory is resolved relative to the loaded module
 * (`pluginDir()` = dirname(import.meta.url)/..): from `src/shared/` that is
 * `src/`, which has no `.opencode/` — but from `dist/index.js` it is the
 * package root, where the shipped `.opencode/command/checkpoint.md` lives.
 * So the copy branch only ever runs from the built artifact; a src-layout
 * test would pin the no-op instead of the product.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpProject: string;

/** Load the BUILT plugin (fresh hooks) against the temp project. */
async function loadHooks(): Promise<void> {
  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  const entry = mod as unknown as { default?: { server?: unknown } };
  const fn = (entry.default?.server ?? entry.default) as (input: unknown) => Promise<unknown>;
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
  await fn({
    directory: tmpProject,
    serverUrl: new URL("http://localhost:0"),
    client: {},
    $: { unsafe: () => {} },
  });
}

const dstFile = () => path.join(tmpProject, ".opencode", "command", "checkpoint.md");
const srcFile = () => path.resolve(".opencode", "command", "checkpoint.md");

beforeAll(async () => {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ic-"));
  // dist/ is gitignored; this file owns that dependency (built by CI before
  // tests, or here on a clean local checkout).
  if (!fs.existsSync(path.resolve("dist/index.js"))) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("npx", ["tsup"], { cwd: path.resolve("."), stdio: "ignore" });
  }
}, 180_000);

afterAll(() => {
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("installPluginCommands (dist layout)", () => {
  it("copies the shipped .opencode/command files into the project on load", async () => {
    expect(fs.existsSync(srcFile())).toBe(true); // the shipped file exists at all
    await loadHooks();
    expect(fs.existsSync(dstFile())).toBe(true);
    expect(fs.readFileSync(dstFile(), "utf-8")).toBe(fs.readFileSync(srcFile(), "utf-8"));
  });

  it("overwrites a stale project copy instead of skipping it", async () => {
    fs.writeFileSync(dstFile(), "corrupted");
    await loadHooks();
    expect(fs.readFileSync(dstFile(), "utf-8")).not.toBe("corrupted");
    expect(fs.readFileSync(dstFile(), "utf-8")).toBe(fs.readFileSync(srcFile(), "utf-8"));
  });
});