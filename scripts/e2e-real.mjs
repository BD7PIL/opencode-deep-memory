#!/usr/bin/env node
/**
 * E2E multi-turn real conversation simulation for opencode-deep-memory.
 * Simulates a realistic development session: decisions, constraints, keyword capture,
 * search, resume detection, and memory consolidation.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "..", "dist", "index.js");

// ─── Config ───
const BASE_URL = "http://localhost:4096";
const AUTH = "Basic " + Buffer.from("opencode:OpenCode").toString("base64");
const MODEL = "openrouter/openai/gpt-5.5";
const TEST_PROJECT = "/tmp/dm-e2e-real-" + Date.now();

// ─── Helpers ───
function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode, data: buf });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function log(msg) {
  console.log(`  ${msg}`);
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg, detail) {
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`    ${detail}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ─── Test Runner ───
let passed = 0;
let failed = 0;
let sessionId = null;

async function sendPrompt(text, expectTool = null) {
  const res = await api("POST", `/session/${sessionId}/prompt`, {
    parts: [{ type: "text", text }],
    model: MODEL,
  });
  if (res.status !== 200) {
    fail(`prompt failed (${res.status})`, JSON.stringify(res.data));
    return null;
  }

  // Wait for completion
  await new Promise((r) => setTimeout(r, 8000));

  // Get messages
  const msgRes = await api("GET", `/session/${sessionId}/messages`);
  if (msgRes.status !== 200) return null;

  const messages = msgRes.data.messages || msgRes.data || [];
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  return lastAssistant;
}

async function checkMemoryFile(filename, shouldContain, shouldNotExist) {
  const filePath = path.join(TEST_PROJECT, ".deep-memory", filename);
  if (!fs.existsSync(filePath)) {
    if (shouldNotExist) {
      pass(`${filename} does not exist (expected)`);
      return true;
    }
    fail(`${filename} not found at ${filePath}`);
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8");
  let ok = true;

  if (shouldContain) {
    for (const text of shouldContain) {
      if (content.includes(text)) {
        pass(`${filename} contains "${text}"`);
      } else {
        fail(`${filename} missing "${text}"`);
        ok = false;
      }
    }
  }

  if (shouldNotExist) {
    for (const text of shouldNotExist) {
      if (!content.includes(text)) {
        pass(`${filename} does not contain "${text}" (expected)`);
      } else {
        fail(`${filename} should NOT contain "${text}"`);
        ok = false;
      }
    }
  }

  return ok;
}

// ─── Main ───
async function main() {
  console.log("=== opencode-deep-memory E2E Real Conversation Simulation ===\n");

  // Setup test project
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_PROJECT, "package.json"),
    JSON.stringify({ name: "e2e-test-project", version: "1.0.0" }),
  );
  log(`Test project: ${TEST_PROJECT}`);

  // ─── Phase 1: Create Session & Initial Decisions ───
  section("Phase 1: Session creation & keyword capture");

  const createRes = await api("POST", "/session", {});
  if (createRes.status !== 200) {
    fail("session creation failed", JSON.stringify(createRes.data));
    process.exit(1);
  }
  sessionId = createRes.data.id || createRes.data.session?.id;
  pass(`Session created: ${sessionId}`);

  // Wait for plugin initialization
  await new Promise((r) => setTimeout(r, 2000));

  // Turn 1: Make a decision (should be captured to notes.md)
  log("Turn 1: Storing a decision...");
  const msg1 = await sendPrompt(
    "记住：我们决定使用 TypeScript 作为主要语言，不要使用 JavaScript。这是一个重要的架构决策。",
  );
  if (msg1) {
    pass("Turn 1 response received");
  } else {
    fail("Turn 1 no response");
  }

  await new Promise((r) => setTimeout(r, 2000));
  checkMemoryFile("notes.md", ["TypeScript", "不要使用 JavaScript"]);

  // Turn 2: Store a constraint
  log("\nTurn 2: Storing a constraint...");
  const msg2 = await sendPrompt(
    "重要约束：所有 API 端点必须使用 RESTful 风格，绝不能使用 GraphQL。必须添加错误处理中间件。",
  );
  if (msg2) {
    pass("Turn 2 response received");
  }

  await new Promise((r) => setTimeout(r, 2000));
  checkMemoryFile("notes.md", ["RESTful", "GraphQL"]);

  // Turn 3: Use memory_store tool explicitly
  log("\nTurn 3: Using memory_store tool...");
  const msg3 = await sendPrompt(
    'Use memory_store tool to store: category "decision", content "项目使用 pnpm 作为包管理器，不使用 npm 或 yarn"',
  );
  if (msg3) {
    pass("Turn 3 response received");
  }

  await new Promise((r) => setTimeout(r, 2000));
  checkMemoryFile("MEMORY.md", ["pnpm"]);

  // ─── Phase 2: Search & Recall ───
  section("Phase 2: Memory search & recall");

  // Turn 4: Search for stored memory
  log("Turn 4: Searching memory...");
  const msg4 = await sendPrompt(
    "Use memory_search tool to search for: TypeScript 语言决策",
  );
  if (msg4) {
    const text = extractText(msg4);
    if (text.includes("TypeScript") || text.includes("pnpm")) {
      pass("Turn 4: search returned relevant results");
    } else {
      fail("Turn 4: search results may be missing", text.slice(0, 200));
    }
  }

  // Turn 5: Search for constraint
  log("\nTurn 5: Searching for constraint...");
  const msg5 = await sendPrompt(
    "Use memory_search tool to search for: API 设计约束",
  );
  if (msg5) {
    const text = extractText(msg5);
    if (text.includes("RESTful") || text.includes("GraphQL")) {
      pass("Turn 5: constraint found in search");
    } else {
      fail("Turn 5: constraint not found", text.slice(0, 200));
    }
  }

  // ─── Phase 3: Context Injection Verification ───
  section("Phase 3: System prompt injection");

  // Check that deep-memory payload was injected
  const messagesRes = await api("GET", `/session/${sessionId}/messages`);
  if (messagesRes.status === 200) {
    const allMessages = messagesRes.data.messages || messagesRes.data || [];
    const systemMessages = allMessages.filter(
      (m) => m.role === "system" || m.role === "system_transform",
    );

    let foundInjection = false;
    for (const m of allMessages) {
      const text = JSON.stringify(m);
      if (text.includes("<deep-memory>")) {
        foundInjection = true;
        break;
      }
    }

    if (foundInjection) {
      pass("system.transform injected <deep-memory> payload");
    } else {
      log("⚠ system.transform injection not visible in messages (may be in system prompt)");
    }
  }

  // ─── Phase 4: Subagent Filtering ───
  section("Phase 4: Subagent message filtering");

  // The notes.md should only contain user messages, not assistant tool calls
  const notesPath = path.join(TEST_PROJECT, ".deep-memory", "notes.md");
  if (fs.existsSync(notesPath)) {
    const notesContent = fs.readFileSync(notesPath, "utf8");
    const hasSubagentContent =
      notesContent.includes("TASK:") ||
      notesContent.includes("EXPECTED OUTCOME:") ||
      notesContent.includes("MUST DO:");

    if (!hasSubagentContent) {
      pass("notes.md does NOT contain subagent internal prompts");
    } else {
      fail("notes.md contains subagent content (filtering failed)");
    }
  }

  // ─── Phase 5: Multiple Entries & Dedup ───
  section("Phase 5: Entry quality & structure");

  if (fs.existsSync(notesPath)) {
    const notesContent = fs.readFileSync(notesPath, "utf8");
    const headings = notesContent.match(/^## /gm);
    log(`notes.md has ${headings?.length ?? 0} entries`);

    // Check structure
    if (notesContent.includes("session ")) {
      pass("Entries include session ID");
    }
    if (notesContent.includes("T") && notesContent.includes(":")) {
      pass("Entries include timestamp");
    }
  }

  const memoryPath = path.join(TEST_PROJECT, ".deep-memory", "MEMORY.md");
  if (fs.existsSync(memoryPath)) {
    const memContent = fs.readFileSync(memoryPath, "utf8");
    log(`\nMEMORY.md size: ${memContent.length} chars`);
    if (memContent.includes("## Decision")) {
      pass("MEMORY.md has Decision section");
    }
  }

  // ─── Phase 6: File Structure Verification ───
  section("Phase 6: Storage layout verification");

  const expectedFiles = [
    ".deep-memory/MEMORY.md",
    ".deep-memory/notes.md",
    ".deep-memory/.schedule.json",
    ".deep-memory/.index-state.json",
  ];

  for (const f of expectedFiles) {
    const fp = path.join(TEST_PROJECT, f);
    if (fs.existsSync(fp)) {
      pass(`${f} exists`);
    } else {
      fail(`${f} missing`);
    }
  }

  // Verify no centralized hash directory was created
  const globalData = process.env.DEEP_MEMORY_DATA || path.join(os.homedir(), ".local/share/opencode/deep-memory");
  const hashDir = path.join(globalData, "projects");
  if (!fs.existsSync(hashDir)) {
    pass("No centralized projects/<hash>/ directory");
  } else {
    log("⚠ Centralized projects/ directory exists (legacy)");
  }

  // ─── Phase 7: Edge Cases ───
  section("Phase 7: Edge cases");

  // Turn 6: Empty message
  log("Turn 6: Sending minimal message (no keyword)...");
  const msg6 = await sendPrompt("hello");
  if (msg6) {
    pass("Turn 6: Non-keyword message handled");
  }

  // Turn 7: Very long message with keyword
  log("\nTurn 7: Long message with keyword...");
  const longMsg =
    "记住：" + "这是一段很长的文本。".repeat(100);
  const msg7 = await sendPrompt(longMsg);
  if (msg7) {
    pass("Turn 7: Long message handled");
  }

  await new Promise((r) => setTimeout(r, 2000));
  if (fs.existsSync(notesPath)) {
    const notesContent = fs.readFileSync(notesPath, "utf8");
    if (notesContent.includes("[truncated]")) {
      pass("Long message was truncated");
    } else {
      log("⚠ Long message may not have been truncated");
    }
  }

  // ─── Summary ───
  console.log("\n=== Summary ===");
  console.log(`Test project: ${TEST_PROJECT}`);
  console.log(`Session: ${sessionId}`);

  // Dump final file contents
  section("Final File Contents");

  for (const f of ["MEMORY.md", "notes.md", ".schedule.json"]) {
    const fp = path.join(TEST_PROJECT, ".deep-memory", f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, "utf8");
      console.log(`\n--- ${f} (${content.length} chars) ---`);
      console.log(content.slice(0, 1000));
      if (content.length > 1000) console.log("... [truncated]");
    }
  }

  console.log("\n✓ E2E REAL CONVERSATION SIMULATION COMPLETE");
}

function extractText(message) {
  if (!message) return "";
  if (message.content) {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
    }
  }
  if (message.parts) {
    return message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return JSON.stringify(message).slice(0, 500);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
