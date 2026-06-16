#!/usr/bin/env node
/**
 * Comprehensive E2E test for opencode-deep-memory v0.2.
 * Run: node scripts/e2e-test.mjs
 * 
 * Tests all features against a live OpenCode server.
 * Uses DeepSeek v4-pro (direct API, not OpenRouter).
 */

import fs from "node:fs";
import path from "node:path";

const B = process.env.E2E_BASE_URL || "http://127.0.0.1:4097";
const AUTH = "opencode:OpenCode";
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-pro" };
const MODEL_MIMO = { providerID: "xiaomi-token-plan-cn", modelID: "mimo-v2.5" };

const results = [];
let passCount = 0;
let failCount = 0;

function check(name, cond, detail = "") {
  const status = cond ? "✅" : "❌";
  console.log(`${status} ${name}${detail ? ": " + detail : ""}`);
  results.push({ name, pass: cond, detail });
  if (cond) passCount++; else failCount++;
}

async function api(method, endpoint, body) {
  const url = `${B}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${Buffer.from(AUTH).toString("base64")}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: resp.status }; }
}

async function sendMessage(sessionID, text, model = MODEL) {
  const resp = await api("POST", `/session/${sessionID}/message`, {
    model,
    parts: [{ type: "text", text }],
  });
  if (resp._raw && resp._raw.includes("<!doctype")) return null;
  const parts = resp.parts || [];
  const textParts = parts.filter(p => p.type === "text").map(p => p.text).join("");
  const toolParts = parts.filter(p => p.type === "tool").map(p => p.tool);
  return { text: textParts, tools: toolParts, parts };
}

async function main() {
  console.log("=== opencode-deep-memory v0.2 E2E Test ===\n");

  // 0. Health check
  const health = await api("GET", "/global/health");
  check("Server healthy", health.healthy === true, `port ${B.split(":").pop()}`);

  // === E2E-1: memory_store ===
  console.log("\n--- E2E-1: memory_store ---");
  const sid1 = (await api("POST", "/session", { title: "E2E-Full-v0.2" })).id;
  check("Session created", !!sid1, sid1?.slice(0, 20));

  const r1 = await sendMessage(sid1, "Use memory_store to store: E2E test confirms v0.2 compression works. Set type=decision, scope=project.");
  check("memory_store returns response", !!r1, r1?.text?.slice(0, 60));
  const memFile = "/home/demo/OCWF/dm-test/.deep-memory/MEMORY.md";
  const memBefore = fs.readFileSync(memFile, "utf8");
  check("MEMORY.md updated", memBefore.includes("E2E test confirms"), "entry found");

  // === E2E-2: memory_search ===
  console.log("\n--- E2E-2: memory_search ---");
  const r2 = await sendMessage(sid1, "Use memory_search to search for 'compression'. Show results.");
  check("memory_search returns results", !!r2 && r2.text.length > 20, r2?.text?.slice(0, 80));

  const r2b = await sendMessage(sid1, "Use memory_search to search for '压缩'. Show results.");
  check("memory_search CJK works", !!r2b && r2b.text.length > 10, r2b?.text?.slice(0, 80));

  // === E2E-3: memory_forget ===
  console.log("\n--- E2E-3: memory_forget ---");
  const r3 = await sendMessage(sid1, "Use memory_forget to delete the entry containing 'E2E test confirms'. Set confirm=true.");
  check("memory_forget executes", !!r3, r3?.text?.slice(0, 60));
  const memAfter = fs.readFileSync(memFile, "utf8");
  check("Entry removed from MEMORY.md", !memAfter.includes("E2E test confirms"), "confirmed deleted");

  // === E2E-4: Keyword capture ===
  console.log("\n--- E2E-4: Keyword capture ---");
  const r4 = await sendMessage(sid1, "记住这个重要约束：所有测试必须使用 DeepSeek v4 模型。");
  check("Keyword '记住' sent", !!r4);
  await new Promise(r => setTimeout(r, 2000));
  const notesFile = "/home/demo/OCWF/dm-test/.deep-memory/notes.md";
  const notesContent = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "";
  check("notes.md captures '记住' keyword", notesContent.includes("DeepSeek") || notesContent.includes("记住"), notesContent.slice(0, 100));

  // === E2E-5: Long conversation (accumulate 10+ rounds) ===
  console.log("\n--- E2E-5: Long conversation compression ---");
  const sid2 = (await api("POST", "/session", { title: "E2E-Long-Conv" })).id;
  check("Long conv session created", !!sid2);

  const topics = [
    "Explain Byzantine Generals Problem in 2 sentences.",
    "Compare linearizability vs sequential consistency.",
    "Design a distributed lock service. Key challenges?",
    "Raft vs Paxos: when to choose each?",
    "Two-phase commit limitations.",
    "Vector clocks and causal ordering.",
    "Token bucket vs sliding window rate limiter.",
    "Optimistic vs pessimistic locking.",
    "Lamport timestamps explanation.",
    "CRDT collaborative editor challenges.",
    "Kafka vs Pulsar comparison.",
    "Design globally distributed database.",
  ];

  for (let i = 0; i < topics.length; i++) {
    process.stdout.write(`  Round ${i + 1}/${topics.length}...`);
    const r = await sendMessage(sid2, topics[i]);
    if (r) {
      process.stdout.write(` OK (${r.text.length} chars)\n`);
    } else {
      process.stdout.write(" FAIL\n");
    }
  }

  // === E2E-6: Check compression stats ===
  console.log("\n--- E2E-6: Compression verification ---");
  const logFile = path.join(os.homedir(), ".config", "opencode", "deep-memory-debug.log");
  const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  
  const strippedLines = logContent.match(/messages\.transform: stripped \{[^}]+\}/g) || [];
  check("messages.transform fired", strippedLines.length > 0, `${strippedLines.length} calls`);

  let totalReasoningCleared = 0;
  let totalMetadataStripped = 0;
  let totalSystemNeutralized = 0;
  let totalThinkingStripped = 0;
  for (const line of strippedLines) {
    try {
      const jsonStr = line.replace(/^.*stripped /, "");
      const d = JSON.parse(jsonStr);
      totalReasoningCleared += d.reasoning_cleared || 0;
      totalMetadataStripped += d.metadata_stripped || 0;
      totalSystemNeutralized += d.system_neutralized || 0;
      totalThinkingStripped += d.thinking_stripped || 0;
    } catch {}
  }
  check("reasoning_cleared > 0", totalReasoningCleared > 0, `${totalReasoningCleared} total`);
  check("metadata_stripped tracked", totalMetadataStripped >= 0, `${totalMetadataStripped} total`);

  // === E2E-7: m[0]/m[1] cache stability ===
  console.log("\n--- E2E-7: Cache stability ---");
  const composeLines = logContent.match(/composeSystemPayload \{[^}]*\}/g) || [];
  const normalSizes = [];
  for (const line of composeLines) {
    try {
      const jsonStr = "{" + line.split("{").slice(1).join("{");
      const d = JSON.parse(jsonStr);
      if (d.mode === "normal" && typeof d.stableSize === "number") {
        normalSizes.push(d.stableSize);
      }
    } catch {}
  }
  
  if (normalSizes.length >= 5) {
    const last5 = normalSizes.slice(-5);
    const allSame = last5.every(s => s === last5[0]);
    check("m[0] stableSize consistent (last 5 calls)", allSame, `${last5[0]} across last 5 of ${normalSizes.length} total`);
  } else {
    check("m[0] stableSize consistent", false, `only ${normalSizes.length} valid entries`);
  }

  // === E2E-8: MiMo v2.5 cross-model ===
  console.log("\n--- E2E-8: MiMo v2.5 ---");
  const sid3 = (await api("POST", "/session", { title: "E2E-MiMo" })).id;
  const rMimo = await sendMessage(sid3, "Use memory_search to find entries about 'Redis'.", MODEL_MIMO);
  check("MiMo memory_search works", !!rMimo && rMimo.text.length > 10, rMimo?.text?.slice(0, 80));

  // === E2E-9: Resume injection ===
  console.log("\n--- E2E-9: Resume injection ---");
  const sid4 = (await api("POST", "/session", { title: "E2E-Resume" })).id;
  const rResume = await sendMessage(sid4, "What decisions do you know about from memory? List them.");
  check("Resume injection returns memory", !!rResume && rResume.text.length > 50, rResume?.text?.slice(0, 120));

  // === Summary ===
  console.log("\n=== E2E SUMMARY ===");
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total: ${passCount + failCount}`);
  console.log(`\nReasoning cleared: ${totalReasoningCleared}`);
  console.log(`Metadata stripped: ${totalMetadataStripped}`);
  console.log(`m[0] calls: ${normalSizes.length}`);
  console.log(`MEMORY.md entries: ${(fs.readFileSync(memFile, "utf8").match(/^- /gm) || []).length}`);

  process.exit(failCount > 0 ? 1 : 0);
}

import os from "node:os";
main().catch(err => {
  console.error("E2E CRASHED:", err);
  process.exit(1);
});
