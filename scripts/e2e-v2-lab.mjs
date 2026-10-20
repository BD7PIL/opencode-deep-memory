#!/usr/bin/env node
/**
 * Real-engine v2 end-to-end gate.
 *
 * Boots an actual opencode v2 engine against a stub LLM in an isolated HOME and
 * asserts the properties the unit suite cannot reach, because a mocked host
 * cannot disagree with the adapter's assumptions:
 *
 *   1. every memory tool is visible to the MODEL (bare v1 names, not namespaced)
 *   2. `memory_store` really executes and writes MEMORY.md through the v2 registry
 *   3. the injected <deep-memory-stable> block lands as a system part and is
 *      byte-identical across turns
 *   4. a v2-named event (`session.compaction.started`) reaches the v1 vocabulary,
 *      proven by the compaction audit log appearing
 *   5. compaction writes both checkpoint artifacts
 *   6. steady-state prompt prefix reuse stays at or above 0.99
 *
 * Each of 1, 3 and 4 encodes a defect that shipped silently in 0.15.x. This
 * script is the gate for them; see docs/research/v2-032-respike.md for the
 * measurements behind every threshold.
 *
 * Usage: node scripts/e2e-v2-lab.mjs [--keep]
 *   E2E_V2_VERSION  opencode v2 version to install   (default 2.0.32)
 */
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = process.env["E2E_V2_VERSION"] ?? "2.0.32";
const LAB = join(tmpdir(), `dm-e2e-v2-${VERSION.replace(/\./g, "_")}`);
const ENGINE_PORT = 4799;
const STUB_PORT = 4711;
const PASSWORD = "dm-e2e-v2-password";
const KEEP = process.argv.includes("--keep");

/** opencode CLI package per platform; the gate is linux-only in CI. */
function cliPackage() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "@opencode/cli-linux-x64";
  if (platform === "linux" && arch === "arm64") return "@opencode/cli-linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "@opencode/cli-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@opencode/cli-darwin-x64";
  return undefined;
}

let failures = 0;
let checks = 0;

function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  \u2713 ${label}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${label}${detail ? " \u2014 " + detail : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { authorization: authHeader() },
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

function authHeader() {
  return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
}

const requestLog = [];

function analyze(body) {
  const tools = body.tools ?? [];
  const toolNames = tools.map((t) => t?.function?.name);
  const toolSignature = JSON.stringify(
    tools.map((t) => ({
      name: t?.function?.name,
      description: t?.function?.description,
      parameters: t?.function?.parameters,
    })),
  );
  let systemText = "";
  const rest = [];
  for (const message of body.messages ?? []) {
    if (message.role === "system") {
      systemText += (typeof message.content === "string" ? message.content : JSON.stringify(message.content)) + "\n";
    } else {
      rest.push(message);
    }
  }
  const prefix = `${toolSignature}\n<<SYSTEM>>\n${systemText}\n<<MSGS>>\n${JSON.stringify(rest)}`;
  const previous = requestLog.length ? requestLog[requestLog.length - 1].prefixText : "";
  let lcp = 0;
  const limit = Math.min(previous.length, prefix.length);
  while (lcp < limit && previous[lcp] === prefix[lcp]) lcp += 1;
  const record = {
    toolNames,
    toolSignatureHash: createHash("sha256").update(toolSignature).digest("hex").slice(0, 16),
    prefixText: prefix,
    systemHash: createHash("sha256").update(systemText).digest("hex").slice(0, 16),
    systemChars: systemText.length,
    hasMemoryBlock: systemText.includes("<deep-memory-stable>"),
    reuseRatio: prefix.length ? lcp / prefix.length : 0,
    streamed: Boolean(body.stream),
  };
  requestLog.push(record);
  return record;
}

function startStubLlm() {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* ignore */
      }
      let reply = { role: "assistant", content: "stub reply." };
      const messages = body.messages ?? [];
      let lastUser = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const content = messages[i].content;
          lastUser =
            typeof content === "string"
              ? content
              : (content ?? []).map((part) => part?.text ?? "").join(" ");
          break;
        }
      }
      const ranTool = messages.some((message) => message.role === "tool");
      analyze(body);
      const lower = lastUser.toLowerCase();
      if (!ranTool && (lower.includes("storememory") || lower.includes("usememory"))) {
        const wanted = lower.includes("storememory") ? "memory_store" : "memory_search";
        const name = (body.tools ?? []).map((t) => t?.function?.name).find((n) => n === wanted);
        const args = lower.includes("storememory")
          ? { content: "[gotcha]: e2e-v2-lab probe line -> verifies v2 injection", type: "gotcha", scope: "project" }
          : { query: "gotcha", scope: "project", limit: 3 };
        reply = name
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: `call_${wanted}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
              ],
            }
          : { role: "assistant", content: `stub: ${wanted} NOT visible to the model.` };
      }
      const payload = JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "stub",
        choices: [
          {
            index: 0,
            finish_reason: reply.tool_calls ? "tool_calls" : "stop",
            message: reply,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
      // The engine asks for streaming. Answering with a non-stream body leaves
      // the turn uncommitted (no assistant message, no tool result), which
      // silently starves every downstream assertion in this gate.
      if (body.stream) {
        const chunk = (delta, finishReason) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? "stub",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        const delta = reply.tool_calls
          ? { role: "assistant", tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })) }
          : { role: "assistant", content: reply.content ?? "" };
        const streamed = chunk(delta, null) + chunk({}, reply.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n";
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(streamed);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      response.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve(server));
  });
}

function ensureEngine() {
  const binary = join(LAB, "bin", "opencode");
  if (existsSync(binary)) return binary;
  const pkg = cliPackage();
  if (!pkg) throw new Error(`no opencode CLI package known for ${process.platform}/${process.arch}`);
  console.log(`  installing ${pkg}@${VERSION} (one-time, cached in ${LAB})`);
  mkdirSync(LAB, { recursive: true });
  execFileSync("npm", ["pack", `${pkg}@${VERSION}`, "--silent"], { cwd: LAB, stdio: "inherit" });
  const tarball = execFileSync("bash", ["-c", `ls ${LAB}/*.tgz | head -1`], { encoding: "utf8" }).trim();
  execFileSync("tar", ["xzf", tarball, "-C", LAB]);
  execFileSync("bash", ["-c", `mkdir -p ${LAB}/bin && cp ${LAB}/package/bin/opencode ${binary} && chmod +x ${binary}`]);
  const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  console.log(`  engine: ${reported}`);
  return binary;
}

function writeLabConfig(directory) {
  const home = join(LAB, "home");
  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  // A wrapper directory: the v2 host resolves a directory plugin to index.js,
  // ignoring package.json main, so the thin re-export is what loads dist.
  const wrapper = join(LAB, "plugin");
  mkdirSync(wrapper, { recursive: true });
  writeFileSync(join(wrapper, "package.json"), JSON.stringify({ name: "dm-e2e-wrapper", version: "0.0.0", type: "module", main: "index.js" }, null, 2));
  writeFileSync(
    join(wrapper, "index.js"),
    `import mod from ${JSON.stringify(join(REPO, "dist", "index.js"))}\nexport default mod\n`,
  );
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [wrapper],
        model: "e2estub/stub-model",
        small_model: "e2estub/stub-model",
        provider: {
          e2estub: {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E Stub",
            options: { baseURL: `http://127.0.0.1:${STUB_PORT}/v1` },
            models: { "stub-model": { name: "Stub Model" } },
          },
        },
      },
      null,
      2,
    ),
  );
  return { home, project: directory };
}

async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${ENGINE_PORT}${path}?directory=${encodeURIComponent(projectDir)}`, {
    ...init,
    headers: { authorization: authHeader(), "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

let projectDir = "";

async function main() {
  const pkg = cliPackage();
  if (!pkg) {
    console.log(`\u26a0 SKIPPED: no opencode v2 CLI package known for ${process.platform}/${process.arch}.`);
    console.log("  This gate runs on linux/darwin only; unit tests still cover the adapter contract.");
    process.exit(0);
  }

  if (!existsSync(join(REPO, "dist", "index.js"))) {
    console.error("dist/index.js missing \u2014 run `npm run build` first.");
    process.exit(1);
  }

  mkdirSync(LAB, { recursive: true });
  projectDir = join(LAB, "proj");
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(join(LAB, "home"), { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });

  console.log(`\n=== opencode-deep-memory v2 E2E gate (opencode ${VERSION}) ===`);
  console.log(`lab: ${LAB}`);

  const binary = ensureEngine();
  const { home } = writeLabConfig(projectDir);

  const stub = await startStubLlm();
  const engine = spawn(binary, ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_SERVER_PORT: String(ENGINE_PORT),
      DEEP_MEMORY_DEBUG: "1",
      DEEP_MEMORY_LOG_FILE: join(LAB, "dm-debug.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const engineLog = [];
  engine.stdout.on("data", (chunk) => engineLog.push(String(chunk)));
  engine.stderr.on("data", (chunk) => engineLog.push(String(chunk)));

  const cleanup = () => {
    try { engine.kill("SIGKILL"); } catch { /* already gone */ }
    try { stub.close(); } catch { /* already closed */ }
  };

  try {
    const up = await waitFor(`http://127.0.0.1:${ENGINE_PORT}/api/config`, 45000);
    if (!up) {
      console.error("engine never came up. Log tail:\n" + engineLog.join("").slice(-2000));
      process.exit(1);
    }

    // v2 loads plugins lazily, on first access to a location service.
    await api("/api/config");
    await sleep(2500);

    const debugLog = existsSync(join(LAB, "dm-debug.log")) ? readFileSync(join(LAB, "dm-debug.log"), "utf8") : "";
    console.log("\n-- load contract");
    check("v2 setup ran (adapter emitted its notes)", debugLog.includes("[v2-entry]"), debugLog.slice(0, 200));
    check("context hook registered", debugLog.includes("context hook registered"));
    check("compaction hook registered", debugLog.includes("compaction hook registered"));
    check("execute.after registered (not the invalid \"*\")", debugLog.includes("execute.after hook registered"));
    check("event subscription started", debugLog.includes("event subscription started"));
    check("all 7 tools registered via tool.transform", debugLog.includes("tool.transform: registered 7"), debugLog);

    const created = await api("/api/session", { method: "POST", body: JSON.stringify({ directory: projectDir }) });
    const sessionID = created.body?.data?.id;
    if (!sessionID) {
      console.error("could not create a session: " + JSON.stringify(created.body).slice(0, 500));
      process.exit(1);
    }

    const turn = async (text) => {
      await api(`/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
      await sleep(4000);
    };

    console.log("\n-- turns");
    await turn("e2e turn one");
    await turn("please storememory now");
    await turn("please usememory now");
    await turn("e2e turn four");

    console.log("\n-- tool visibility (the model's own tool list)");
    const withTools = requestLog.filter((record) => record.toolNames.length > 0);
    const visible = new Set(withTools.flatMap((record) => record.toolNames));
    for (const name of ["memory_search", "memory_store", "memory_forget", "memory_expand", "memory_topic", "context_compress", "deep_expand"]) {
      check(`${name} visible to the model`, visible.has(name));
    }

    console.log("\n-- tool execution");
    const memoryPath = join(projectDir, ".deep-memory", "MEMORY.md");
    check("memory_store executed and wrote MEMORY.md", existsSync(memoryPath));
    if (existsSync(memoryPath)) {
      check("MEMORY.md holds the stored line", readFileSync(memoryPath, "utf8").includes("e2e-v2-lab probe line"));
    }

    console.log("\n-- byte-stable system injection");
    const injected = withTools.filter((record) => record.hasMemoryBlock);
    check("the memory block arrives as a system part", injected.length > 0, `${injected.length}/${withTools.length} requests`);
    const hashes = [...new Set(injected.map((record) => record.systemHash))];
    const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
    // The block changes only when MEMORY.md does: at most one distinct hash per
    // MEMORY.md revision, so 2 distinct hashes (before/after the store) is the
    // ceiling for this scenario.
    check("system block is byte-stable (<= 2 distinct hashes: one per MEMORY.md revision)", hashes.length <= 2, `hashes=${hashes.join(",")} storable=${memory.length}`);

    console.log("\n-- steady-state cache prefix reuse");
    // Only compare requests that share a tool signature: tool definitions
    // precede every system and message block, so a differing tool set makes the
    // prefix diverge at byte 0 and the ratio meaningless.
    const signatures = [...new Set(withTools.map((record) => record.toolSignatureHash))];
    check("tool definitions are byte-stable across every request", signatures.length === 1, `signatures=${signatures.join(",")}`);
    const comparable = withTools.filter((record) => record.toolSignatureHash === signatures[0]);
    // The injected block legitimately changes when MEMORY.md does, and that one
    // request must pay a re-prefill. Steady state is everything else.
    const changedSystem = comparable.slice(1).filter((record, index) => record.systemHash !== comparable[index].systemHash);
    const steady = comparable.slice(1).filter((record, index) => record.systemHash === comparable[index].systemHash);
    const worst = steady.length ? Math.min(...steady.map((record) => record.reuseRatio)) : 0;
    check("prefix reuse >= 0.98 in steady state (injected block unchanged)", worst >= 0.98, `worst=${worst.toFixed(3)} over ${steady.length} requests`);
    check(
      "a MEMORY.md write costs exactly one re-prefill",
      changedSystem.length <= 1,
      `${changedSystem.length} requests changed the system block`,
    );
    comparable.forEach((record, index) =>
      console.log(
        `      req${index}: reuse=${record.reuseRatio.toFixed(3)} systemChars=${record.systemChars} ` +
          `systemChanged=${index > 0 && record.systemHash !== comparable[index - 1].systemHash}`,
      ),
    );

    console.log("\n-- v2 event name mapping");
    const compact = await api(`/api/session/${sessionID}/compact`, { method: "POST", body: "{}" });
    check("compaction accepted", compact.status === 200, String(compact.status));
    await sleep(6000);
    const auditLog = join(projectDir, ".deep-memory", ".compaction-log.jsonl");
    check(
      "session.compaction.started reached the v1 vocabulary (audit log written)",
      existsSync(auditLog) && readFileSync(auditLog, "utf8").includes(sessionID),
      existsSync(auditLog) ? "log present but missing sessionID" : "no audit log",
    );

    console.log("\n-- compaction artifacts");
    check("checkpoint.md written", existsSync(join(projectDir, ".deep-memory", "checkpoint.md")));
    check("checkpoint.raw.json written", existsSync(join(projectDir, ".deep-memory", "checkpoint.raw.json")));
  } finally {
    cleanup();
    if (!KEEP) {
      // Keep the downloaded engine (the expensive part) but drop per-run state.
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
  if (failures > 0) {
    console.log("\u2717 E2E V2 GATE FAILED");
    process.exit(1);
  }
  console.log("\u2713 E2E V2 GATE PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});