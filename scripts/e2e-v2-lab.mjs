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
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
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
  if (platform === "win32" && arch === "x64") return "@opencode/cli-windows-x64";
  if (platform === "win32" && arch === "arm64") return "@opencode/cli-windows-arm64";
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
  // The WHOLE system prompt is not the plugin's to stabilise: the harness adds
  // environment sections whose content legitimately moves as files appear (the
  // plugin itself writes MEMORY.md, checkpoints, .pending-consolidation.json).
  // The property this gate owns is the injected block's own byte-stability, so
  // extract and hash that specifically.
  const blockMatch = systemText.match(/<deep-memory-stable>[\s\S]*?<\/deep-memory-stable>/);
  const injectedBlock = blockMatch ? blockMatch[0] : "";
  const record = {
    toolNames,
    blockHash: createHash("sha256").update(injectedBlock).digest("hex").slice(0, 16),
    blockChars: injectedBlock.length,
    toolSignatureHash: createHash("sha256").update(toolSignature).digest("hex").slice(0, 16),
    prefixText: prefix,
    systemHash: createHash("sha256").update(systemText).digest("hex").slice(0, 16),
    systemChars: systemText.length,
    hasMemoryBlock: systemText.includes("<deep-memory-stable>"),
    // The 0.15.x adapter injected into the last user message under this marker.
    // Its reappearance would mean the injection regressed to the tail channel.
    legacyTailMarkers: (JSON.stringify(body).match(/<deep-memory-context>/g) ?? []).length,
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
  const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
  const binary = join(LAB, "bin", executable);
  if (existsSync(binary)) return binary;
  const pkg = cliPackage();
  if (!pkg) throw new Error(`no opencode CLI package known for ${process.platform}/${process.arch}`);
  console.log(`  installing ${pkg}@${VERSION} (one-time, cached in ${LAB})`);
  mkdirSync(LAB, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["pack", `${pkg}@${VERSION}`, "--silent"], {
    cwd: LAB,
    stdio: "inherit",
    // Node 24 on Windows refuses to spawn .cmd files without a shell.
    shell: process.platform === "win32",
  });
  const tarball = readdirSync(LAB).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack produced no tarball in ${LAB}`);
  // Git-for-Windows ships GNU tar, which reads "C:" as a remote host. Use the
  // Windows bsdtar explicitly so absolute paths stay local.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["xzf", join(LAB, tarball), "-C", LAB]);
  mkdirSync(join(LAB, "bin"), { recursive: true });
  copyFileSync(join(LAB, "package", "bin", executable), binary);
  chmodSync(binary, 0o755);
  const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  console.log(`  engine: ${reported}`);
  return binary;
}

function writeLabConfig(directory) {
  const home = join(LAB, "home");
  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  // The v2 host resolves a directory plugin to index.js and never reads
  // package.json, so the repo root must be loadable as-is — the same path an
  // air-gapped directory install takes.
  const pluginDir = REPO;
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [pluginDir],
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
  // The engine appends to this log, so a stale log from a previous run makes
  // every count-based assertion accumulate across runs (a two-run history once
  // read as "two consolidation spawns", i.e. a cascade that never happened).
  rmSync(join(LAB, "dm-debug.log"), { force: true });
  mkdirSync(projectDir, { recursive: true });
  // Seed a MEMORY.md past the idle-consolidation threshold (>= 20 lines). The
  // v1 handler returns silently below it, so a threshold-crossing file is what
  // makes the idle path observable at all; an accumulated memory file is also
  // the real-world condition the path exists for.
  mkdirSync(join(projectDir, ".deep-memory"), { recursive: true });
  // Seed a MEMORY.md past the idle-consolidation threshold (>= 20 lines). The v1
  // handler returns SILENTLY below it, so a threshold-crossing file is what makes
  // the idle path observable at all; an accumulated memory file is also the
  // real-world condition that path exists for.
  //
  // The entries are deliberately substantively distinct. Near-identical seed
  // lines are collapsed by the write-time near-duplicate check, which silently
  // shrank MEMORY.md mid-run and moved the injected system block twice.
  writeFileSync(
    join(projectDir, ".deep-memory", "MEMORY.md"),
    [
      "# Project Memory",
      "",
      "## Decisions",
      "- [decision]: summary-block placement is chosen from the measured cached-prefix length, not from intuition [2026-10-20]",
      "- [decision]: the memory block rides an appended system part because a byte-stable payload belongs in the cacheable prefix [2026-10-20]",
      "",
      "## Gotchas",
      "- [gotcha]: opencode v2 emits no session.idle, so it is mapped from session.execution.succeeded [2026-10-20]",
      "- [gotcha]: ctx.event.subscribe returns an AsyncIterable rather than accepting a callback [2026-10-20]",
      "- [gotcha]: a v2 tool needs options.namespace or it never reaches the agent tool list [2026-10-20]",
      "- [gotcha]: v2 exposes no session.messages; message reads go through ctx.session.context [2026-10-20]",
      "",
      "## Constraints",
      "- [constraint]: sample processor runs on a 25 kHz clock domain while the ADC samples asynchronously [2026-10-20]",
      "- [constraint]: provider breakpoint budget is four and manual hints spend from the same budget [2026-10-20]",
      "- [constraint]: a cache prefix matches from the start, so an early mutation costs everything after it [2026-10-20]",
      "",
      "## Facts",
      "- [fact]: pyright and jdtls are registered as language servers in the shared opencode config [2026-10-20]",
      "- [fact]: the sample service answers over the loopback interface at 127.0.0.1 [2026-10-20]",
      "- [fact]: a provisioning CLI installs a remote editor instance over ssh and relays its egress [2026-10-20]",
      "- [fact]: headroom is a transport-layer proxy, so it composes with a plugin-layer memory manager [2026-10-20]",
      "- [fact]: nine of the twenty-six v2 context faces are absent from the published authoring types [2026-10-20]",
      "- [fact]: the DEVICE-42 pattern generator needs an explicit level set before fast adjustment [2026-10-20]",
      "- [fact]: idle consolidation fires at eight stored entries or at twenty accumulated lines [2026-10-20]",
      "- [fact]: measured steady-state prompt prefix reuse on the lab engine is 0.996 [2026-10-20]",
      "- [fact]: the compaction hook receives the full message list, so capture needs no client fetch [2026-10-20]",
      "- [fact]: event names in v2 are namespaced by lifecycle rather than by the v1 notification vocabulary [2026-10-20]",
      "- [fact]: the v2 engine loads plugins lazily, on the first access to a location service [2026-10-20]",
      "",
    ].join("\n"),
  );

  const binary = ensureEngine();
  const { home } = writeLabConfig(projectDir);

  const stub = await startStubLlm();
  const engine = spawn(binary, ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: home,
      // HOME alone is NOT isolation: the engine resolves its config through
      // XDG_CONFIG_HOME, and CI runners set it, so inheriting the runner's
      // environment sent config resolution outside the lab entirely -- the
      // engine then read no opencode.json, loaded no plugins and configured no
      // provider. Pin every XDG root into the lab home so the sandbox is real.
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
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

  const dumpDiagnostics = async (adapterLog) => {
    console.log("\n-- diagnostics (engine log tail)");
    console.log(engineLog.join("").slice(-3000) || "(engine produced no output)");
    try {
      // The engine's own plugin registry is the authoritative answer to "was the
      // plugin seen, and did it come up?", which a grep of our own log cannot give.
      const plugins = await api("/api/plugin");
      const entries = (plugins.body?.data ?? []).map((entry) => ({
        id: entry.id,
        source: entry.source?.type,
        status: entry.state?.status,
      }));
      console.log("-- diagnostics (/api/plugin): " + JSON.stringify(entries).slice(0, 2000));
    } catch (error) {
      console.log("-- diagnostics (/api/plugin) failed: " + String(error));
    }
    console.log("-- diagnostics (adapter log tail)");
    console.log((adapterLog || "(no adapter log at all)").slice(-2000));
    console.log(
      `-- diagnostics: ${requestLog.length} LLM requests logged; ` +
        `adapter log ${adapterLog ? "present" : "MISSING"}; ` +
        `dist ${existsSync(join(REPO, "dist", "index.js")) ? "present" : "MISSING"}; ` +
        `wrapper ${existsSync(join(LAB, "plugin", "index.js")) ? "present" : "MISSING"}`,
    );
  };

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

    if (failures > 0) {
      // Nothing downstream can be meaningful if the plugin never came up, and
      // continuing would spend five turns of condition-waits before saying so.
      await dumpDiagnostics(debugLog);
      throw new Error("opencode v2 plugin did not load — see diagnostics above");
    }

    const created = await api("/api/session", { method: "POST", body: JSON.stringify({ directory: projectDir }) });
    const sessionID = created.body?.data?.id;
    if (!sessionID) {
      console.error("could not create a session: " + JSON.stringify(created.body).slice(0, 500));
      process.exit(1);
    }

    // The pending-consolidation file is written when the idle handler spawns a
    // sub-session and UNLINKED when the next idle consumes the entry, so it has
    // to be sampled between turns rather than inspected at the end.
    const pendingCandidates = [
      join(projectDir, ".pending-consolidation.json"),
      join(projectDir, ".deep-memory", ".pending-consolidation.json"),
    ];
    let pendingSighting;
    const memorySizes = [];
    const waitUntil = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(500);
      }
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${label})`);
      return false;
    };

    const turn = async (text, expect) => {
      const before = requestLog.length;
      const response = await api(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      if (response.status !== 200) {
        console.log(`      prompt "${text}" -> HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
      }
      // Condition-based, not a fixed sleep: on a cold CI runner the engine
      // installs the provider SDK on the first model call, which takes far
      // longer than the warm local lab where fixed sleeps looked sufficient.
      await waitUntil(() => requestLog.length > before, 180_000, `an LLM request for "${text}"`);
      if (expect) await waitUntil(expect, 180_000, "the expected effect of that turn");
      for (const candidate of pendingCandidates) {
        if (existsSync(candidate)) pendingSighting = { path: candidate, raw: readFileSync(candidate, "utf8") };
      }
      memorySizes.push(sampleMemory());
    };

    const memoryFile = join(projectDir, ".deep-memory", "MEMORY.md");
    const sampleMemory = () =>
      existsSync(memoryFile)
        ? `${readFileSync(memoryFile, "utf8").length}B/${readFileSync(memoryFile, "utf8").split("\n").length}L`
        : "absent";
    const seededMemory = readFileSync(memoryFile, "utf8");
    memorySizes.push(`start=${sampleMemory()}`);
    console.log("\n-- turns");
    // The store turn comes FIRST so MEMORY.md settles before the spawn: a write
    // after the spawn trips the mtime-race guard, which discards the entry before
    // the read face is ever exercised.
    await turn("please storememory now", () => readFileSync(memoryFile, "utf8") !== seededMemory);
    await turn("please usememory now");
    await turn("e2e turn three");
    await turn("e2e turn four");
    await turn("e2e turn five");

    console.log("\n-- tool visibility (the model's own tool list)");
    check("the stub LLM was reached at all", requestLog.length > 0, `${requestLog.length} requests logged`);
    const withTools = requestLog.filter((record) => record.toolNames.length > 0);
    check("at least one request carried a tool list", withTools.length > 0, `${withTools.length} of ${requestLog.length}`);
    const visible = new Set(withTools.flatMap((record) => record.toolNames));
    for (const name of ["memory_search", "memory_store", "memory_forget", "memory_expand", "memory_topic", "context_compress", "deep_expand"]) {
      check(`${name} visible to the model`, visible.has(name));
    }

    console.log("\n-- tool execution");
    const memoryPath = join(projectDir, ".deep-memory", "MEMORY.md");
    // Non-vacuous: the gate seeds MEMORY.md itself, so mere existence proves
    // nothing. It must have CHANGED.
    check(
      "memory_store executed and wrote MEMORY.md",
      existsSync(memoryPath) && readFileSync(memoryPath, "utf8") !== seededMemory,
      existsSync(memoryPath) ? "file unchanged from the seed" : "file missing",
    );
    if (existsSync(memoryPath)) {
      check("MEMORY.md holds the stored line", readFileSync(memoryPath, "utf8").includes("e2e-v2-lab probe line"));
    }

    console.log("\n-- injection channel");
    const injected = withTools.filter((record) => record.hasMemoryBlock);
    check("the memory block arrives as a system part", injected.length > 0, `${injected.length}/${withTools.length} requests`);
    // Byte-stability of the block itself is asserted in the cache section below,
    // against the injected block rather than the whole harness prompt.
    const legacyHits = withTools.reduce((total, record) => total + record.legacyTailMarkers, 0);
    check(
      "the retired last-user-message channel is gone",
      legacyHits === 0,
      `${legacyHits} <deep-memory-context> markers still in flight`,
    );

    console.log("\n-- steady-state cache prefix reuse");
    // Only compare requests that share a tool signature: tool definitions
    // precede every system and message block, so a differing tool set makes the
    // prefix diverge at byte 0 and the ratio meaningless.
    const signatures = [...new Set(withTools.map((record) => record.toolSignatureHash))];
    check("tool definitions are byte-stable across every request", signatures.length === 1, `signatures=${signatures.join(",")}`);
    const comparable = withTools.filter((record) => record.toolSignatureHash === signatures[0]);

    // Assert on the block the plugin owns.
    const withBlock = comparable.filter((record) => record.blockChars > 0);
    check(
      "the injected block is present in every primary request",
      comparable.length > 0 && withBlock.length === comparable.length,
      `${withBlock.length}/${comparable.length}`,
    );
    const blockHashes = [...new Set(withBlock.map((record) => record.blockHash))];
    check(
      "the injected block is byte-stable while MEMORY.md is unchanged",
      blockHashes.length <= 2,
      `${blockHashes.length} distinct blocks (one per MEMORY.md revision expected)`,
    );
    const changedBlock = withBlock.slice(1).filter((record, index) => record.blockHash !== withBlock[index].blockHash);
    check(
      "a MEMORY.md write costs exactly one block change",
      changedBlock.length <= 1,
      `${changedBlock.length} requests changed the injected block`,
    );

    // Report whole-prefix reuse as an observation. It is bounded by the harness's
    // own system prompt as well as by our block, so it is NOT asserted tightly.
    const steady = withBlock.slice(1).filter((record, index) => record.blockHash === withBlock[index].blockHash);
    const worst = steady.length ? Math.min(...steady.map((record) => record.reuseRatio)) : 0;
    console.log(`      whole-prefix reuse min in steady state: ${worst.toFixed(3)} over ${steady.length} requests (harness system prompt also moves it)`);
    comparable.forEach((record, index) =>
      console.log(
        `      req${index}: reuse=${record.reuseRatio.toFixed(3)} systemChars=${record.systemChars} ` +
          `blockChars=${record.blockChars} blockChanged=${index > 0 && record.blockHash !== comparable[index - 1].blockHash}`,
      ),
    );
    console.log(`      MEMORY.md after each turn: ${memorySizes.join(" -> ")}`);

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

    // ── the idle path: session.execution.succeeded -> session.idle ────────────
    // 0.15.x dropped this entirely (v2 emits no session.idle), and the v1
    // handler returns SILENTLY below the consolidation threshold, so asserting
    // "no error" would prove nothing. The MEMORY.md seeded above crosses the
    // threshold, which makes the handler's work observable end to end.
    console.log("\n-- idle path (session.execution.succeeded -> session.idle)");
    const idleLog = existsSync(join(LAB, "dm-debug.log")) ? readFileSync(join(LAB, "dm-debug.log"), "utf8") : "";
    const spawnCount = idleLog.split("idle consolidation: spawned").length - 1;
    check("the idle handler ran past the threshold and spawned consolidation", spawnCount >= 1, `spawns=${spawnCount}`);
    // The cascade risk is specific: the spawned sub-session emits its own idle,
    // and if that were treated as a normal session the plugin would spawn a
    // grandchild, then a great-grandchild, one per generation. What must hold is
    // that the guard fires — NOT that spawns is one, because the next legitimate
    // spawn is gated by the 60s cooldown rather than by the run length.
    const skippedSubSessionIdles = idleLog.split("skipping plugin-spawned sub-session").length - 1;
    check(
      "the spawned sub-session's own idle is skipped (no cascade)",
      skippedSubSessionIdles >= 1,
      `skips=${skippedSubSessionIdles} spawns=${spawnCount}`,
    );
    check(
      "re-spawns are cooldown-bounded, not per-turn",
      idleLog.includes("idle consolidation: cooldown active, skipping"),
      "no cooldown message logged",
    );
    // The apply branch reads the sub-session's last assistant message through the
    // v2 client adapter (ctx.session.context), so either outcome proves that read
    // face returned something parseable on a real engine.
    const readFaceReached = idleLog.includes("idle consolidation: applied") || idleLog.includes("idle consolidation: rejected");
    check(
      "the v2 read face answered (ctx.session.context fed the apply branch)",
      readFaceReached,
      idleLog.includes("idle consolidation: discarded (mtime race)")
        ? "the entry was discarded on an mtime race before the read"
        : "neither 'applied' nor 'rejected' logged",
    );
    check(
      "a later idle consumed the pending entry",
      readFaceReached || idleLog.includes("idle consolidation: discarded (mtime race)") || idleLog.includes("idle consolidation: failed to apply"),
      "no terminal outcome for the pending entry",
    );
    // state.bestModel() is only non-undefined thanks to the chat.params bridge.
    check("chat.params bridge recorded agent/model", idleLog.includes("chat.params: recorded agent+model"));

    check(
      "pending-consolidation file observed between turns",
      Boolean(pendingSighting),
      `sampled ${pendingCandidates.join(" and ")} after every turn`,
    );
    let spawnedSubSessionID;
    if (pendingSighting) {
      const pending = JSON.parse(pendingSighting.raw);
      const entries = Array.isArray(pending.entries) ? pending.entries : [pending];
      spawnedSubSessionID = entries[0]?.subSessionID;
      check(
        "pending entry names the spawned sub-session",
        typeof spawnedSubSessionID === "string" && spawnedSubSessionID.startsWith("ses_"),
        JSON.stringify(entries[0]),
      );
      check("pending file lives at the project root", pendingSighting.path.endsWith(".pending-consolidation.json"));
    }
    const sessions = await api("/api/session");
    const children = (sessions.body?.data ?? []).filter(
      (item) => (item.parentID ?? item.parent) === sessionID,
    );
    check(
      "ctx.session.create spawned a real child session on the engine",
      children.length >= 1,
      `${children.length} children of ${sessionID}; ids=${children.map((item) => item.id).join(",")}`,
    );
    if (spawnedSubSessionID) {
      check(
        "the recorded sub-session is the engine's child session",
        children.some((item) => item.id === spawnedSubSessionID),
        `recorded=${spawnedSubSessionID} engine=${children.map((item) => item.id).join(",")}`,
      );
    }
  } finally {
    cleanup();
    if (!KEEP) {
      // Keep the downloaded engine (the expensive part) but drop per-run state.
      // Windows may still hold handles right after the engine is killed; a
      // leftover temp dir must not turn a green gate red.
      try {
        rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        console.warn(`  (cleanup skipped: ${error.code ?? error.message})`);
      }
    }
  }

  if (failures > 0) {
    await dumpDiagnostics(existsSync(join(LAB, "dm-debug.log")) ? readFileSync(join(LAB, "dm-debug.log"), "utf8") : "");
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