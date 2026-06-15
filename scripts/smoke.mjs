#!/usr/bin/env node
/**
 * CLI smoke test for opencode-deep-memory.
 *
 * Loads the built dist/index.js, exercises all hooks + tools with mock data,
 * and verifies end-to-end behavior including the project-local storage layout.
 *
 * Usage:
 *   npm run build && npm run smoke
 *   npm run smoke -- --project /custom/tmp/dir
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
  console.log("=== opencode-deep-memory CLI smoke test ===");
  console.log(`projectPath: ${tmpProject}`);
  console.log(`globalRoot:  ${tmpGlobal}`);
  console.log();

  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  check("dist/index.js loads", typeof mod.default === "object" && typeof mod.default.server === "function");
  const pluginFn = mod.default.server ?? mod.default;
  check("PluginModule.server is callable", typeof pluginFn === "function");

  const mockClient = {
    session: {
      create: async () => ({ data: { id: "mock-dream-session" } }),
      promptAsync: async () => undefined,
      messages: async () => ({ data: [] }),
    },
  };
  const input = {
    directory: tmpProject,
    project: { path: tmpProject },
    worktree: tmpProject,
    serverUrl: new URL("http://localhost:0"),
    client: mockClient,
    $: { unsafe: () => {} },
  };

  const hooks = await pluginFn(input);
  check("Plugin factory returns Hooks object", typeof hooks === "object" && hooks !== null);
  check("chat.params registered", typeof hooks["chat.params"] === "function");
  check("chat.message registered", typeof hooks["chat.message"] === "function");
  check("experimental.chat.system.transform registered", typeof hooks["experimental.chat.system.transform"] === "function");
  check("experimental.session.compacting registered", typeof hooks["experimental.session.compacting"] === "function");
  check("event registered", typeof hooks.event === "function");
  check("tool registered with 3 tools", hooks.tool && Object.keys(hooks.tool).length === 3);
  check("memory_search tool present", !!hooks.tool.memory_search);
  check("memory_store tool present", !!hooks.tool.memory_store);
  check("memory_forget tool present", !!hooks.tool.memory_forget);

  console.log();
  console.log("--- Hook: chat.params ---");
  await hooks["chat.params"](
    {
      sessionID: "smoke-sess-1",
      agent: "sisyphus",
      model: { id: "test-model" },
      provider: {},
      message: { role: "user" },
    },
    { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} },
  );
  check("chat.params executes without error", true);

  console.log();
  console.log("--- Hook: chat.message (keyword capture → notes.md) ---");
  await hooks["chat.message"](
    { sessionID: "smoke-sess-1" },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "记住这个决策：使用 ESM 模块" }],
    },
  );
  const notesPath = path.join(tmpProject, ".deep-memory", "notes.md");
  check("notes.md created at project-local path", fs.existsSync(notesPath), notesPath);
  check("notes.md contains the user message", fs.readFileSync(notesPath, "utf8").includes("使用 ESM 模块"));

  console.log();
  console.log("--- Hook: experimental.chat.system.transform ---");
  const sysOutput = { system: [] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "smoke-sess-1", model: { id: "test-model" } },
    sysOutput,
  );
  check("system.transform pushes 1 fragment", sysOutput.system.length === 1);
  check("payload starts with <deep-memory>", sysOutput.system[0].startsWith("<deep-memory>"));
  check("payload contains <tool-hint>", sysOutput.system[0].includes("<tool-hint>"));
  check("payload ends with </deep-memory>", sysOutput.system[0].trimEnd().endsWith("</deep-memory>"));
  console.log(`    payload size: ${sysOutput.system[0].length} chars`);

  console.log();
  console.log("--- Hook: event (session.created) ---");
  await hooks.event({
    event: {
      type: "session.created",
      properties: {
        info: {
          id: "smoke-sess-created",
          title: "Smoke Test Session",
          directory: tmpProject,
        },
      },
    },
  });
  check("event session.created executes without error", true);
  check("auto-dream schedule file created", fs.existsSync(path.join(tmpProject, ".deep-memory", ".schedule.json")));

  console.log();
  console.log("--- Hook: event (session.compacted → audit log) ---");
  await hooks.event({
    event: {
      type: "session.compacted",
      properties: { sessionID: "smoke-sess-compact-1" },
    },
  });
  const auditLogPath = path.join(tmpProject, ".deep-memory", ".compaction-log.jsonl");
  check("session.compacted executes without error", true);
  check("compaction audit log created", fs.existsSync(auditLogPath), auditLogPath);
  if (fs.existsSync(auditLogPath)) {
    const logContent = fs.readFileSync(auditLogPath, "utf8");
    check("audit log contains sessionID", logContent.includes("smoke-sess-compact-1"));
  }

  console.log();
  console.log("--- Hook: event (session.idle — no pending enrichment) ---");
  await hooks.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "smoke-sess-idle-1" },
    },
  });
  check("session.idle (no pending enrichment) executes without error", true);

  console.log();
  console.log("--- Distill schedule (30-day cycle) ---");
  const scheduleContent = fs.readFileSync(path.join(tmpProject, ".deep-memory", ".schedule.json"), "utf8");
  const schedule = JSON.parse(scheduleContent);
  check("schedule has lastDistill field", "lastDistill" in schedule);
  check("schedule has lastDream field", "lastDream" in schedule);

  console.log();
  console.log("--- Command files ---");
  const cmdDir = path.resolve(".opencode", "command");
  check("/checkpoint command exists", fs.existsSync(path.join(cmdDir, "checkpoint.md")));
  check("/dream command exists", fs.existsSync(path.join(cmdDir, "dream.md")));
  check("/distill command exists", fs.existsSync(path.join(cmdDir, "distill.md")));

  console.log();
  console.log("--- Tool: memory_store ---");
  const storeResult = await hooks.tool.memory_store.execute({
    content: "本插件使用纯 JS BM25 而非 SQLite",
    type: "decision",
    scope: "project",
  });
  check("memory_store returns string", typeof storeResult === "string");
  const memoryPath = path.join(tmpProject, ".deep-memory", "MEMORY.md");
  check("MEMORY.md created at project-local path", fs.existsSync(memoryPath), memoryPath);
  check("MEMORY.md contains '## Decision'", fs.readFileSync(memoryPath, "utf8").includes("## Decision"));
  check("MEMORY.md contains stored content", fs.readFileSync(memoryPath, "utf8").includes("纯 JS BM25"));

  console.log();
  console.log("--- Tool: memory_search ---");
  // Index needs a moment to pick up the file; call ensureIndex by searching
  const searchResult = await hooks.tool.memory_search.execute({
    query: "BM25",
    scope: "project",
    limit: 5,
  });
  check("memory_search returns string", typeof searchResult === "string");
  check("memory_search finds the stored entry", searchResult.includes("BM25"), searchResult.slice(0, 200));

  console.log();
  console.log("--- Tool: memory_search (CJK) ---");
  const cjkResult = await hooks.tool.memory_search.execute({
    query: "纯 JS",
    scope: "project",
    limit: 5,
  });
  check("memory_search finds CJK content", cjkResult.includes("纯") || cjkResult.includes("BM25"));

  console.log();
  console.log("--- Tool: memory_forget (preview mode) ---");
  const forgetPreview = await hooks.tool.memory_forget.execute({
    query: "BM25",
    scope: "project",
    confirm: false,
  });
  check("memory_forget (preview) returns string", typeof forgetPreview === "string");

  console.log();
  console.log("--- Tool: memory_forget (confirmed) ---");
  const forgetResult = await hooks.tool.memory_forget.execute({
    query: "BM25",
    scope: "project",
    confirm: true,
  });
  check("memory_forget (confirm) returns string", typeof forgetResult === "string");
  const memoryContentAfter = fs.readFileSync(memoryPath, "utf8");
  check("MEMORY.md no longer contains the entry", !memoryContentAfter.includes("纯 JS BM25"), memoryContentAfter);

  console.log();
  console.log("--- Storage layout verification ---");
  check("project memory at <project>/.deep-memory/", fs.existsSync(path.join(tmpProject, ".deep-memory")));
  check("notes.md in project-local dir", fs.existsSync(path.join(tmpProject, ".deep-memory", "notes.md")));
  check("MEMORY.md in project-local dir", fs.existsSync(path.join(tmpProject, ".deep-memory", "MEMORY.md")));
  check("schedule file in project-local dir", fs.existsSync(path.join(tmpProject, ".deep-memory", ".schedule.json")));
  check("index-state file in project-local dir", fs.existsSync(path.join(tmpProject, ".deep-memory", ".index-state.json")));
  check("NO legacy projects/<hash>/ dir was created", !fs.existsSync(path.join(tmpGlobal, "projects")));

  console.log();
  console.log("=== Summary ===");
  console.log(`passed: ${pass}`);
  console.log(`failed: ${fail}`);

  if (!customProject) {
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
      fs.rmSync(tmpGlobal, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  if (fail > 0) {
    console.error("\nSMOKE TEST FAILED");
    process.exit(1);
  } else {
    console.log("\n✓ SMOKE TEST PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
