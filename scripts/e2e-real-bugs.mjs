#!/usr/bin/env node
/**
 * Real-E2E bug regression — v0.14.1's three production bugs as scripted
 * scenarios (batch D2 follow-up).
 *
 * These three bugs shipped through 450 green unit tests because every test
 * mocked the args the way the author's own callsite did. They only surfaced
 * when the plugin ran inside a real opencode. Each scenario below reproduces
 * the ORIGINAL bug condition against the built dist and asserts the FIXED
 * behavior, so a regression re-introducing any of them fails this script.
 *
 *   1. SCOPE-DEFAULT CRASH (b048ed7 bug 1)
 *      memory_store called the way a REAL opencode tool call arrives — args
 *      missing `scope`/`type` entirely (zod .default() does not run outside
 *      the TUI) — must store successfully instead of crashing with
 *      'paths[0] must be of type string'.
 *
 *   2. JACCARD/FORMAT-MISMATCH DEDUP MISS (b048ed7 bugs 2+3)
 *      Real V5 MEMORY.md entries are stored as "- content" (no [type]
 *      prefix). Write-time dedup must catch an exact duplicate of such an
 *      entry ("Near-duplicate detected (similarity 100%)") and must NOT
 *      false-positive on short lines that merely share tokens
 *      ('test decision' vs 'test gotcha' — the removed SimHash path).
 *
 *   3. PENDING-PERSIST AFTER CONSUME (50e8ec7)
 *      When the idle handler consumes a pending consolidation (sub-session
 *      finished), the removal must be persisted to .pending-consolidation.json
 *      in the SAME turn — otherwise stale entries resurrect across restarts.
 *
 * Run: npm run build && node scripts/e2e-real-bugs.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dm-realbugs-"));
const tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "dm-realbugs-global-"));
process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpGlobal;

let pass = 0, fail = 0;
function check(label, cond, details = "") {
  if (cond) { console.log(`  \u2713 ${label}`); pass++; }
  else { console.error(`  \u2717 ${label} ${details}`); fail++; }
}

function toolCtx(sessionID) {
  return { sessionID: sessionID ?? "rb-sess", messageID: "msg-1", agent: "general", directory: tmpProject, worktree: tmpProject, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} };
}

function makeClient(toastSpy) {
  return {
    session: {
      create: async () => ({ data: { id: "mock-sub" } }),
      promptAsync: async () => undefined,
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: toastSpy ?? (async () => undefined) },
    $: { unsafe: () => {} },
    config: { get: async () => ({ data: undefined }) },
  };
}

async function loadHooks(client) {
  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  const pluginFn = mod.default.server ?? mod.default;
  delete globalThis["__deepMemoryCachedHooks"];
  return pluginFn({
    directory: tmpProject,
    serverUrl: new URL("http://localhost:0"),
    client: client ?? makeClient(),
    $: { unsafe: () => {} },
  });
}

const memPath = path.join(tmpProject, ".deep-memory", "MEMORY.md");
function readMemory() {
  try { return fs.readFileSync(memPath, "utf8"); } catch { return ""; }
}

async function main() {
  console.log("=== real-E2E bug regression (v0.14.1 trio) ===");
  console.log(`projectPath: ${tmpProject}\n`);

  // ─── Bug 2c: consolidation dedup handles real '- content' format ─────────
  console.log("--- Bug 2c: consolidation dedup on real format (b048ed7 #3) ---");
  // Driven through the REAL idle-apply path (dist bundle): the sub-session
  // mock returns a summary containing '- content' entries (no [type] prefix);
  // the apply runs consolidateMemory over the real MEMORY.md. Pre-0.14.1 the
  // '- [' filter silently skipped every real entry → no dedup at all.
  fs.mkdirSync(path.join(tmpProject, ".deep-memory"), { recursive: true });
  // Baseline ≥20 lines so shouldConsolidate() fires (delta ≥20 over fresh state);
  // the dedup target lines ride at the top.
  fs.writeFileSync(memPath, [
    "## Gotchas",
    "- keep the real-format entry",
    "- unique survivor entry",
    ...Array.from({ length: 24 }, (_, i) => `- [decision] baseline consolidation filler ${i + 1} with padding`),
  ].join("\n"), "utf8");
  const toasts2c = [];
  const mergedClient = makeClient(async (t) => { toasts2c.push(t); });
  const hooks2c = await loadHooks({
    ...mergedClient,
    session: {
      ...makeClient().session,
      messages: async (opts) => {
        if (opts?.query?.limit === 1) {
          // Summary keeps >=30% of the original 27 lines (validateConsolidation
          // over-deletion guard) while carrying a duplicate real-format entry.
          return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: [
            "## Gotchas",
            "- keep the real-format entry",   // real '- content' entry must survive apply
            "- consolidated new entry",       // sub-session's own contribution must merge
            ...Array.from({ length: 9 }, (_, i) => `- [decision] baseline consolidation filler ${i + 1} with padding`),
          ].join("\n") }] }] };
        }
        return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }] };
      },
    },
  });
  await hooks2c["chat.params"](
    { sessionID: "rb-2c", agent: "test", model: { id: "m", providerID: "p" }, provider: {}, message: { role: "user" } },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  await hooks2c.event({ event: { type: "session.idle", properties: { sessionID: "rb-2c" } } });   // spawn
  await hooks2c.event({ event: { type: "session.idle", properties: { sessionID: "rb-2c" } } });   // apply
  await new Promise((r) => setTimeout(r, 120));
  const mem2c = readMemory();
  check("apply succeeded (consolidated toast)", toasts2c.some((t) => t?.body?.message?.includes("memory consolidated")), JSON.stringify(toasts2c.map((t) => t?.body?.message)));
  check("real '- content' entry preserved through apply", mem2c.includes("- keep the real-format entry"), mem2c.slice(0, 200));
  check("sub-session entry merged", mem2c.includes("consolidated new entry"), mem2c.slice(0, 200));
  console.log();

  // ─── Bug 3: pending consolidation removal is persisted after consume ─────
  console.log("--- Bug 3: pending persist after consume (50e8ec7) ---");
  const pendingFile = path.join(tmpProject, ".deep-memory", ".pending-consolidation.json");
  // 0.16.6 re-poll semantics: an idle tick with a non-terminal sub-session
  // KEEPS the pending entry by design. Drive a terminal assistant message so
  // this test exercises what it is here for — the consume path syncing disk.
  const hooks3 = await loadHooks({
    ...makeClient(),
    session: {
      ...makeClient().session,
      messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }] }),
    },
  });
  // Spawn path persists the pending entry (pre-existing behavior)...
  fs.mkdirSync(path.join(tmpProject, ".deep-memory"), { recursive: true });
  const memForSpawn = Array.from({ length: 30 }, (_, i) => `- [decision] consolidation trigger line ${i + 1} with padding`).join("\n");
  fs.writeFileSync(memPath, memForSpawn, "utf8");
  await hooks3["chat.params"](
    { sessionID: "rb-3", agent: "test", model: { id: "m", providerID: "p" }, provider: {}, message: { role: "user" } },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  // persistPendingConsolidation writes <project>/.pending-consolidation.json
  // (project ROOT, synchronous).
  await hooks3.event({ event: { type: "session.idle", properties: { sessionID: "rb-3" } } });
  const rootPending = path.join(tmpProject, ".pending-consolidation.json");
  const spawned = fs.existsSync(rootPending) && fs.readFileSync(rootPending, "utf8").includes("rb-3");
  check("spawn persisted pending entry", spawned, fs.existsSync(rootPending) ? fs.readFileSync(rootPending, "utf8").slice(0, 120) : "no file");

  // ...the FIX under test: the CONSUME path (second idle) must also sync disk —
  // the consumed entry must disappear (file rewritten without it, or removed
  // entirely when it was the only entry).
  await hooks3.event({ event: { type: "session.idle", properties: { sessionID: "rb-3" } } });
  const afterConsume = fs.existsSync(rootPending) ? fs.readFileSync(rootPending, "utf8") : "{}";
  check("consumed entry removed from disk", !afterConsume.includes("rb-3"), afterConsume.slice(0, 160));
  console.log();

  // ─── Bug 1: memory_store without scope/type (the exact real-call shape) ──
  console.log("--- Bug 1: scope-default crash (b048ed7 #1) ---");
  const hooks1 = await loadHooks();
  let result1;
  try {
    // REAL opencode tool calls pass ONLY the args the model provided — no
    // scope, no type. The pre-0.14.1 build crashed here with
    // 'paths[0] must be of type string, got undefined'.
    result1 = await hooks1.tool.memory_store.execute({ content: "EL7 glibc 2.17 is the hard floor for native binaries" }, toolCtx("rb-1"));
  } catch (err) {
    result1 = { error: err };
  }
  const text1 = JSON.stringify(result1);
  check("store without scope/type does not throw", !result1.error, String(result1.error ?? ""));
  check("store succeeds", /Stored|stored/i.test(text1), text1.slice(0, 120));
  check("entry landed in project MEMORY.md", readMemory().includes("EL7 glibc 2.17"), readMemory().slice(0, 120));
  console.log();

  // ─── Bug 2a: exact duplicate of a real-format entry is caught ────────────
  console.log("--- Bug 2a: dedup catches real-format duplicates (b048ed7 #2) ---");
  const hooks2 = await loadHooks();
  // First store through the tool (creates a real '- content' entry)
  await hooks2.tool.memory_store.execute({ content: "watch for the SimHash false positive on short entries" }, toolCtx("rb-2"));
  const before = readMemory();
  // Second identical store must be REJECTED by write-time dedup
  const result2 = await hooks2.tool.memory_store.execute({ content: "watch for the SimHash false positive on short entries" }, toolCtx("rb-2"));
  const text2 = JSON.stringify(result2);
  check("near-duplicate detected", /Near-duplicate/i.test(text2), text2.slice(0, 160));
  check("duplicate NOT appended", readMemory() === before, "MEMORY.md changed on duplicate store");
  console.log();

  // ─── Bug 2b: short-line false-positive must NOT fire ─────────────────────
  console.log("--- Bug 2b: short-line false-positive guard (b048ed7 #2b) ---");
  const hooks2b = await loadHooks();
  await hooks2b.tool.memory_store.execute({ content: "test decision" }, toolCtx("rb-2b"));
  // 'test gotcha' shares 1 of 2 tokens with 'test decision' — the removed
  // SimHash path flagged this as a duplicate; exact-match-only must store it.
  const result2b = await hooks2b.tool.memory_store.execute({ content: "test gotcha" }, toolCtx("rb-2b"));
  const text2b = JSON.stringify(result2b);
  check("distinct short entry stored", !/Near-duplicate/i.test(text2b), text2b.slice(0, 160));
  check("both entries present", readMemory().includes("test decision") && readMemory().includes("test gotcha"));
  console.log();

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log("=== Summary ===");
  console.log(`passed: ${pass}`);
  console.log(`failed: ${fail}`);
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpGlobal, { recursive: true, force: true }); } catch {}
  if (fail > 0) { console.error("\nREAL-BUG REGRESSION FAILED"); process.exit(1); }
  else { console.log("\n\u2713 REAL-BUG REGRESSION PASSED"); process.exit(0); }
}

main().catch((err) => { console.error("regression crashed:", err); process.exit(1); });
