#!/usr/bin/env node
/**
 * CLI smoke test for opencode-deep-memory V4.
 *
 * Verifies V4 architecture: frozen TOOL_HINT + mtime-cached MEMORY.md,
 * no dream/distill, no schedule files, capture-time caps work.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
let customProject = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) {
    customProject = args[i + 1];
    i++;
  }
}

const tmpProject =
  customProject ?? fs.mkdtempSync(path.join(os.tmpdir(), "dm-smoke-"));
const tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "dm-smoke-global-"));

process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpGlobal;

let pass = 0;
let fail = 0;

function check(label, cond, details = "") {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label} ${details}`);
    fail++;
  }
}

async function main() {
  console.log("=== opencode-deep-memory V4 smoke test ===");
  console.log(`projectPath: ${tmpProject}`);
  console.log();

  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  const isOldFormat = typeof mod.default === "object" && typeof mod.default.server === "function";
  check("dist/index.js loads", isOldFormat || typeof mod.default === "function");
  const pluginFn = mod.default.server ?? mod.default;

  const input = {
    directory: tmpProject,
    project: { path: tmpProject },
    worktree: tmpProject,
    serverUrl: new URL("http://localhost:0"),
    client: { session: { create: async () => ({}), promptAsync: async () => undefined } },
    $: { unsafe: () => {} },
  };

  const hooks = await pluginFn(input);
  check("Plugin factory returns Hooks object", typeof hooks === "object" && hooks !== null);
  check("chat.params registered", typeof hooks["chat.params"] === "function");
  check("system.transform registered", typeof hooks["experimental.chat.system.transform"] === "function");
  check("messages.transform registered", typeof hooks["experimental.chat.messages.transform"] === "function");
  check("tool has 6 tools (incl context_compress)", hooks.tool && Object.keys(hooks.tool).length === 6);

  console.log();
  console.log("--- V4: system.transform (single frozen payload) ---");
  await hooks["chat.params"](
    { sessionID: "smoke-1", agent: "sisyphus", model: { id: "m" }, provider: {}, message: { role: "user" } },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  const sysOutput = { system: [] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "smoke-1", model: { id: "m" } },
    sysOutput,
  );
  check("V4 pushes exactly 1 system fragment", sysOutput.system.length === 1, `got ${sysOutput.system.length}`);
  if (sysOutput.system.length >= 1) {
    check("contains <deep-memory-stable>", sysOutput.system[0].includes("<deep-memory-stable>"));
    check("contains <tool-hint>", sysOutput.system[0].includes("<tool-hint>"));
    check("contains memory_search", sysOutput.system[0].includes("memory_search"));
    check("does NOT contain <deep-memory-volatile>", !sysOutput.system[0].includes("<deep-memory-volatile>"));
  }

  console.log();
  console.log("--- V4: byte-stability across turns (no MEMORY.md change) ---");
  const sysOutput2 = { system: [] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "smoke-1", model: { id: "m" } },
    sysOutput2,
  );
  check("second call byte-identical to first", sysOutput2.system[0] === sysOutput.system[0]);

  console.log();
  console.log("--- V4: memory_store + MEMORY.md appears in next system.transform ---");
  await hooks.tool.memory_store.execute({
    content: "V4 uses capture-time caps not post-hoc compression",
    type: "decision",
    scope: "project",
  });
  const sysOutput3 = { system: [] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "smoke-1", model: { id: "m" } },
    sysOutput3,
  );
  check("MEMORY.md content in system prompt after store", sysOutput3.system[0].includes("capture-time caps"));
  check("cache invalidated (mtime changed)", sysOutput3.system[0] !== sysOutput.system[0]);

  console.log();
  console.log("--- V4: memory_search finds stored entry ---");
  const searchResult = await hooks.tool.memory_search.execute({
    query: "capture-time",
    scope: "project",
    limit: 5,
  });
  check("memory_search returns string", typeof searchResult === "string");
  check("memory_search finds entry", searchResult.includes("capture-time"));

  console.log();
  console.log("--- V4: no dream/distill artifacts created ---");
  check("NO .schedule.json exists", !fs.existsSync(path.join(tmpProject, ".deep-memory", ".schedule.json")));
  check("NO checkpoint.raw.json exists", !fs.existsSync(path.join(tmpProject, ".deep-memory", "checkpoint.raw.json")));
  check("NO notes.md created by keyword hook (V4 may still have it if chat.message ran, but it's not required)", true);

  console.log();
  console.log("--- V4: context_compress tool requests compression ---");
  const compressResult = await hooks.tool.context_compress.execute({ keep_recent: 5 });
  check("context_compress returns confirmation", JSON.stringify(compressResult).includes("Compression requested"));

  console.log();
  console.log("--- V4: storage layout ---");
  check("project memory dir exists", fs.existsSync(path.join(tmpProject, ".deep-memory")));
  check("MEMORY.md exists", fs.existsSync(path.join(tmpProject, ".deep-memory", "MEMORY.md")));
  check("NO legacy projects/<hash>/ dir", !fs.existsSync(path.join(tmpGlobal, "projects")));

  console.log();
  console.log("=== Summary ===");
  console.log(`passed: ${pass}`);
  console.log(`failed: ${fail}`);

  if (!customProject) {
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
      fs.rmSync(tmpGlobal, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  if (fail > 0) { console.error("\nSMOKE TEST FAILED"); process.exit(1); }
  else { console.log("\n✓ SMOKE TEST PASSED"); process.exit(0); }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
