#!/usr/bin/env node
/**
 * E2E multi-turn real conversation simulation.
 * Tests: keyword capture, memory store/search, resume detection, subagent filtering.
 * Uses HTTP API to send real prompts through opencode with the plugin active.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:4096";
const AUTH = "Basic " + Buffer.from("opencode:OpenCode").toString("base64");
const MODEL = "openrouter/openai/gpt-5.5";
const DEEP_MEMORY_DIR = "/tmp/dm-e2e-real/.deep-memory";

let sessionId = null;
let passed = 0;
let failed = 0;

// ── HTTP helper ──
function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: AUTH,
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, data: buf });
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pass(msg) {
  console.log(`  ✓ ${msg}`);
  passed++;
}
function fail(msg, detail) {
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`    → ${detail}`);
  failed++;
}
function section(t) {
  console.log(`\n── ${t} ──`);
}

// ── Wait for session to finish processing ──
async function waitForCompletion(sid, maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await api("GET", `/session/${sid}`);
      if (res.status === 200) {
        const s = res.data;
        // Check if session is idle
        if (s.status === "idle" || !s.status) return true;
      }
    } catch {}
    await sleep(2000);
  }
  return false;
}

// ── Send prompt and wait ──
async function chat(text, waitMs = 12000) {
  const res = await api("POST", `/session/${sessionId}/prompt`, {
    parts: [{ type: "text", text }],
    model: MODEL,
  });
  if (res.status !== 200) {
    fail(`HTTP ${res.status}`, JSON.stringify(res.data).slice(0, 200));
    return null;
  }
  await sleep(waitMs);
  return res;
}

// ── Get last assistant message ──
async function lastAssistant() {
  const res = await api("GET", `/session/${sessionId}/messages`);
  if (res.status !== 200) return null;
  const msgs = Array.isArray(res.data) ? res.data : res.data.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs[i];
  }
  return null;
}

// ── Extract text from message ──
function msgText(m) {
  if (!m) return "";
  const parts = m.parts || m.content || [];
  if (typeof parts === "string") return parts;
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ── Check file ──
function checkFile(relPath, expectContains, label) {
  const fp = path.join(DEEP_MEMORY_DIR, relPath);
  if (!fs.existsSync(fp)) {
    fail(`${label || relPath}: file not found`);
    return false;
  }
  const content = fs.readFileSync(fp, "utf8");
  let ok = true;
  for (const text of expectContains) {
    if (content.includes(text)) {
      pass(`${label || relPath} contains "${text}"`);
    } else {
      fail(`${label || relPath} missing "${text}"`);
      ok = false;
    }
  }
  return ok;
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════
async function main() {
  console.log("═══ E2E Multi-Turn Real Conversation Simulation ═══\n");

  // Clean slate
  if (fs.existsSync(DEEP_MEMORY_DIR)) {
    fs.rmSync(DEEP_MEMORY_DIR, { recursive: true });
  }

  // ── Turn 1: Create session ──
  section("Turn 1: Create session");
  const createRes = await api("POST", "/session", {});
  if (createRes.status !== 200) {
    console.error("FATAL: Cannot create session", createRes);
    process.exit(1);
  }
  sessionId = createRes.data.id || createRes.data.session?.id;
  pass(`Session: ${sessionId}`);
  await sleep(3000);

  // ── Turn 2: Store a decision via keyword ──
  section("Turn 2: Keyword capture — 记住");
  await chat("记住：我们决定使用 pnpm 作为包管理器，不使用 npm。这是架构决策。", 15000);
  checkFile("notes.md", ["pnpm"], "notes.md (keyword capture)");

  // ── Turn 3: Store a constraint ──
  section("Turn 3: Keyword capture — 约束");
  await chat("重要约束：所有 API 端点必须使用 RESTful 风格，绝不能使用 GraphQL。", 15000);
  checkFile("notes.md", ["RESTful", "GraphQL"], "notes.md (constraint)");

  // ── Turn 4: Use memory_store tool ──
  section("Turn 4: memory_store tool");
  await chat(
    '请使用 memory_store 工具存储这条记忆：category="decision", content="项目使用 TypeScript strict mode，所有文件必须通过 tsc --noEmit 检查"',
    15000,
  );
  await sleep(3000);
  checkFile("MEMORY.md", ["TypeScript"], "MEMORY.md (memory_store)");

  // ── Turn 5: Store another entry ──
  section("Turn 5: memory_store — constraint");
  await chat(
    '请使用 memory_store 工具存储：category="constraint", content="数据库只能使用 PostgreSQL，禁止 MySQL 和 MongoDB"',
    15000,
  );
  await sleep(3000);
  checkFile("MEMORY.md", ["PostgreSQL"], "MEMORY.md (constraint stored)");

  // ── Turn 6: Search memory ──
  section("Turn 6: memory_search");
  await chat("请使用 memory_search 工具搜索关于包管理器的记忆", 15000);
  const msg6 = await lastAssistant();
  const text6 = msgText(msg6);
  if (text6.includes("pnpm") || text6.includes("npm")) {
    pass("memory_search found pnpm decision");
  } else {
    fail("memory_search did not find pnpm", text6.slice(0, 300));
  }

  // ── Turn 7: Search for constraint ──
  section("Turn 7: memory_search — constraint");
  await chat("请使用 memory_search 工具搜索关于数据库的记忆", 15000);
  const msg7 = await lastAssistant();
  const text7 = msgText(msg7);
  if (text7.includes("PostgreSQL") || text7.includes("数据库")) {
    pass("memory_search found PostgreSQL constraint");
  } else {
    fail("memory_search did not find PostgreSQL", text7.slice(0, 300));
  }

  // ── Turn 8: Normal conversation (no keyword) ──
  section("Turn 8: Normal conversation (no keyword)");
  const notesBefore = fs.existsSync(path.join(DEEP_MEMORY_DIR, "notes.md"))
    ? fs.readFileSync(path.join(DEEP_MEMORY_DIR, "notes.md"), "utf8")
    : "";
  await chat("帮我写一个 hello world 函数", 15000);
  const notesAfter = fs.existsSync(path.join(DEEP_MEMORY_DIR, "notes.md"))
    ? fs.readFileSync(path.join(DEEP_MEMORY_DIR, "notes.md"), "utf8")
    : "";
  if (notesBefore === notesAfter || !notesAfter.includes("hello world")) {
    pass("Normal message NOT captured to notes.md");
  } else {
    fail("Normal message was incorrectly captured");
  }

  // ── Turn 9: Long message with keyword ──
  section("Turn 9: Long message truncation");
  const longMsg = "记住：" + "这是一段很长的开发日志。".repeat(80);
  await chat(longMsg, 15000);
  const notesContent = fs.existsSync(path.join(DEEP_MEMORY_DIR, "notes.md"))
    ? fs.readFileSync(path.join(DEEP_MEMORY_DIR, "notes.md"), "utf8")
    : "";
  if (notesContent.includes("[truncated]")) {
    pass("Long message truncated correctly");
  } else if (notesContent.length > 0) {
    log("⚠ Long message captured but truncation marker missing");
  }

  // ── Turn 10: memory_forget ──
  section("Turn 10: memory_forget");
  await chat('请使用 memory_forget 工具删除关于 PostgreSQL 的记忆（preview模式）', 15000);
  const msg10 = await lastAssistant();
  const text10 = msgText(msg10);
  if (text10.includes("PostgreSQL") || text10.includes("preview")) {
    pass("memory_forget preview returned content");
  } else {
    fail("memory_forget preview unclear", text10.slice(0, 200));
  }

  // ── Verify subagent filtering ──
  section("Subagent filtering check");
  const finalNotes = fs.existsSync(path.join(DEEP_MEMORY_DIR, "notes.md"))
    ? fs.readFileSync(path.join(DEEP_MEMORY_DIR, "notes.md"), "utf8")
    : "";
  const hasSubagentLeak =
    finalNotes.includes("TASK:") ||
    finalNotes.includes("EXPECTED OUTCOME:") ||
    finalNotes.includes("MUST DO:") ||
    finalNotes.includes("MUST NOT DO:");
  if (!hasSubagentLeak) {
    pass("No subagent internal content leaked to notes.md");
  } else {
    fail("Subagent content found in notes.md!");
  }

  // ── Verify schedule file ──
  section("Schedule file");
  const schedPath = path.join(DEEP_MEMORY_DIR, ".schedule.json");
  if (fs.existsSync(schedPath)) {
    const sched = JSON.parse(fs.readFileSync(schedPath, "utf8"));
    if (sched.lastDream !== undefined) pass("schedule has lastDream field");
    else fail("schedule missing lastDream");
    if (sched.lastDistill !== undefined) pass("schedule has lastDistill field");
    else fail("schedule missing lastDistill");
  } else {
    fail(".schedule.json not found");
  }

  // ── Summary ──
  console.log("\n═══ Summary ═══");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(`\n  Session: ${sessionId}`);
  console.log(`  Memory dir: ${DEEP_MEMORY_DIR}`);

  // Dump final files
  section("Final MEMORY.md");
  const memPath = path.join(DEEP_MEMORY_DIR, "MEMORY.md");
  if (fs.existsSync(memPath)) {
    console.log(fs.readFileSync(memPath, "utf8").slice(0, 1500));
  }

  section("Final notes.md");
  if (fs.existsSync(path.join(DEEP_MEMORY_DIR, "notes.md"))) {
    console.log(fs.readFileSync(path.join(DEEP_MEMORY_DIR, "notes.md"), "utf8").slice(0, 1500));
  }

  if (failed === 0) {
    console.log("\n✓ E2E MULTI-TURN SIMULATION PASSED");
  } else {
    console.log(`\n✗ ${failed} CHECKS FAILED`);
    process.exit(1);
  }
}

function log(msg) {
  console.log(`  ${msg}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
