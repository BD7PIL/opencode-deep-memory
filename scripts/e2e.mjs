#!/usr/bin/env node
/**
 * V5.1 E2E test — all three layers through plugin hooks.
 * Run: node scripts/e2e.mjs [--project /tmp/dm-e2e-test]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
let customProject = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) { customProject = args[i + 1]; i++; }
}

const tmpProject = customProject ?? fs.mkdtempSync(path.join(os.tmpdir(), "dm-e2e-"));
const tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "dm-e2e-global-"));

process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpGlobal;

let pass = 0, fail = 0;
function check(label, cond, details = "") {
  if (cond) { console.log(`  \u2713 ${label}`); pass++; }
  else { console.error(`  \u2717 ${label} ${details}`); fail++; }
}

function makeClient(toastSpy) {
  return {
    session: {
      create: async () => ({ data: { id: "mock-sub-001" } }),
      promptAsync: async () => undefined,
      messages: async (opts) => {
        if (opts?.query?.limit === 1) {
          return {
            data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Mock summary of compressed content.\n## Decisions\n- Test decision\n## Constraints\n- Test constraint\n## Gotchas\n- Test gotcha" }] }],
          };
        }
        const msgs = [];
        for (let i = 0; i < 15; i++) msgs.push({ info: { role: "assistant" }, parts: [{ type: "text", text: `msg${i}` }] });
        return { data: msgs };
      },
    },
    tui: { showToast: toastSpy ?? (async () => undefined) },
    $: { unsafe: () => {} },
    config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4-5" } }) },
  };
}

function toolCtx(sessionID) {
  return { sessionID: sessionID ?? "e2e-sess", messageID: "msg-1", agent: "general", directory: tmpProject, worktree: tmpProject, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} };
}

/** Write a MEMORY.md with the given line count. */
function writeMemory(lines) {
  const dir = path.join(tmpProject, ".deep-memory");
  fs.mkdirSync(dir, { recursive: true });
  const content = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), content, "utf8");
}

async function main() {
  console.log("=== opencode-deep-memory V5.1 E2E test ===");
  console.log(`projectPath: ${tmpProject}`);
  console.log();

  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  const pluginFn = mod.default.server ?? mod.default;

  async function loadHooks(client) {
    delete globalThis["__deepMemoryCachedHooks"];
    return pluginFn({
      directory: tmpProject, project: { path: tmpProject }, worktree: tmpProject,
      serverUrl: new URL("http://localhost:0"), client: client ?? makeClient(), $: { unsafe: () => {} },
    });
  }

  // ─── Layer 1: deterministic compression unchanged ────────────────
  console.log("--- Layer 1: strip_thinking ---");
  const h1 = await loadHooks();
  const msgs = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "setup" }] },
    { info: { role: "assistant" }, parts: [{ type: "thinking", text: "thinking..." }, { type: "text", text: "answer." }] },
  ];
  for (let i = 0; i < 6; i++) msgs.push({ info: { role: "user" }, parts: [{ type: "text", text: `q${i}` }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: `a${i}` }] });
  const out1 = { messages: JSON.parse(JSON.stringify(msgs)) };
  await h1["experimental.chat.messages.transform"]({}, out1);
  check("thinking parts stripped from compressible zone", !out1.messages.some(m => m.parts?.some?.(p => p.type === "thinking")));
  console.log();

  // ─── Layer 2: path A (summary provided) ──────────────────────────
  console.log("--- Layer 2: path A (summary provided) ---");
  const h2 = await loadHooks();
  const rA = await h2.tool.context_compress.execute({ keep_recent: 5, summary: "Existing path" }, toolCtx("e2e-a"));
  check("returns Compression scheduled", JSON.stringify(rA).includes("Compression scheduled"));
  check("uses existing path", JSON.stringify(rA).includes("captured in your summary"));
  console.log();

  // ─── Layer 2: path B (no summary, subagent spawn + toast) ────────
  console.log("--- Layer 2: path B (subagent spawn + spawn toast) ---");
  const toasts2 = [];
  const h3 = await loadHooks(makeClient(async (t) => { toasts2.push(t); }));
  const rB = await h3.tool.context_compress.execute({ keep_recent: 5 }, toolCtx("e2e-b"));
  check("returns Compression scheduled", JSON.stringify(rB).includes("Compression scheduled"));
  check("spawn toast fired", toasts2.some(t => t?.body?.message?.includes("spawned")), JSON.stringify(toasts2));
  console.log();

  // ─── Layer 2: subagent result applied + applied toast ────────────
  console.log("--- Layer 2: subagent result + applied toast ---");
  const toasts2a = [];
  const h4 = await loadHooks(makeClient(async (t) => { toasts2a.push(t); }));
  await h4.tool.context_compress.execute({ keep_recent: 3 }, toolCtx("e2e-c"));
  const msgs2 = [];
  for (let i = 0; i < 10; i++) msgs2.push({ info: { role: "user" }, parts: [{ type: "text", text: `q${i}` }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: `a${i}` }] });
  const out2 = { messages: JSON.parse(JSON.stringify(msgs2)) };
  await h4["experimental.chat.messages.transform"]({ sessionID: "e2e-c" }, out2);
  const summaryBlock = out2.messages.find(m => m.parts?.some?.(p => p.type === "text" && p.text?.includes("[compressed-block")));
  check("subagent summary injected", summaryBlock !== undefined, `found=${!!summaryBlock}`);
  check("applied toast fired", toasts2a.some(t => t?.body?.message?.includes("context compressed")), `toasts=${toasts2a.length}`);
  console.log();

  // ─── Layer 3: consolidation spawn toast (write MEMORY.md, trigger idle) ─
  console.log("--- Layer 3: consolidation spawn toast ---");
  const consToasts = [];
  const consClient = makeClient(async (t) => { consToasts.push(t); });
  writeMemory(30);
  const h5 = await loadHooks(consClient);
  await h5["chat.params"](
    { sessionID: "e2e-cons", agent: "test", model: { id: "m" }, provider: {}, message: { role: "user" } },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  await h5.event({ event: { type: "session.idle", properties: { sessionID: "e2e-cons" } } });
  check("spawn toast for consolidation", consToasts.some(t => t?.body?.message?.includes("consolidation spawned")), JSON.stringify(consToasts));
  console.log();

  // ─── Layer 3: consolidation applied toast (second idle checks subagent) ─
  console.log("--- Layer 3: consolidation applied toast ---");
  await h5.event({ event: { type: "session.idle", properties: { sessionID: "e2e-cons" } } });
  const hasApplied = consToasts.some(t => t?.body?.message?.includes("memory consolidated"));
  const hasSpawn = consToasts.filter(t => t?.body?.message?.includes("consolidation spawned")).length;
  check("result toast on second idle", hasApplied || hasSpawn >= 2, `total_toasts=${consToasts.length} spawn=${hasSpawn} applied=${hasApplied}`);
  console.log();

  // ─── Layer 3: consolidation mtime discard toast ─────────────────
  console.log("--- Layer 3: consolidation mtime discard toast ---");
  // Fresh state: write MEMORY.md, trigger idle to spawn
  const discToasts = [];
  const discClient = makeClient(async (t) => { discToasts.push(t); });
  writeMemory(30);
  const h6 = await loadHooks(discClient);
  await h6["chat.params"](
    { sessionID: "e2e-disc", agent: "test", model: { id: "m" }, provider: {}, message: { role: "user" } },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  await h6.event({ event: { type: "session.idle", properties: { sessionID: "e2e-disc" } } });
  check("discard test: spawn toast", discToasts.some(t => t?.body?.message?.includes("consolidation spawned")), "no spawn toast before discard test");
  // Touch MEMORY.md to advance mtime past recorded value
  const memPath = path.join(tmpProject, ".deep-memory", "MEMORY.md");
  const content = fs.readFileSync(memPath, "utf8");
  await new Promise(r => setTimeout(r, 50)); // ensure mtime changes
  fs.writeFileSync(memPath, content + "\n# touched", "utf8");
  // Second idle: should find mtime race and discard
  await h6.event({ event: { type: "session.idle", properties: { sessionID: "e2e-disc" } } });
  check("discard toast on mtime race", discToasts.some(t => t?.body?.message?.includes("discarded")), JSON.stringify(discToasts));
  console.log();

  // ─── Toast: only subagent operations ────────────────────────────
  console.log("--- Toast: subagent-only policy ---");
  const allToasts = [];
  const h7 = await loadHooks(makeClient(async (t) => { allToasts.push(t); }));
  await h7.tool.context_compress.execute({ keep_recent: 5 }, toolCtx("e2e-toast"));
  check("no compression stat toasts", allToasts.every(t => !t?.body?.message?.includes("stripped")));
  check("no injection stat toasts", allToasts.every(t => !t?.body?.message?.includes("injected")));
  console.log();

  // ─── Summary ────────────────────────────────────────────────────
  console.log("=== Summary ===");
  console.log(`passed: ${pass}`);
  console.log(`failed: ${fail}`);

  if (!customProject) {
    try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpGlobal, { recursive: true, force: true }); } catch {}
  }

  if (fail > 0) { console.error("\nE2E TEST FAILED"); process.exit(1); }
  else { console.log("\n\u2713 E2E TEST PASSED"); process.exit(0); }
}

main().catch((err) => { console.error("E2E test crashed:", err); process.exit(1); });
