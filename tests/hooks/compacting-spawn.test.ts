/**
 * Compacting spawn-branch tests — batch 0.15.1 (plan item P3-19).
 *
 * Covers the three Step-4c branches that the happy-path compacting tests
 * never touch:
 *  - cooldown: a consolidation attempt within 60s suppresses the spawn
 *  - session.create rejection: swallowed, never throws out of the hook
 *  - bestModel: the recorded project model is forwarded in promptAsync
 *
 * The spawn only fires when MEMORY.md exceeds 50 lines, so each test writes
 * a padded MEMORY.md first.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompactingHandler } from "../../src/hooks/compacting.js";
import { createPluginState, type PluginState } from "../../src/hooks/shared-state.js";
import { mockHostClient } from "../helpers/mock-host.js";
import { vi } from "vitest";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-spawnbranch-"));
}

/** The spawn gate needs MEMORY.md > 50 lines AFTER the hook's dedup pass
 *  (token Jaccard ≥ 0.9 collapses similar lines), so the lines must be
 *  lexically disjoint — every line carries unique tokens. */
function paddedMemory(): string {
  const words = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
    "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "argento", "borealis", "cobalt", "dynamo",
    "emitter", "falcon", "granite", "harbor", "ionics", "jetfire", "krypton", "lumen", "marble", "nickel",
    "onyx", "platinum", "quartz", "ruby", "sapphire", "topaz", "uranium", "vanadium", "tungsten", "xenon",
    "yttrium", "zinc", "amber", "basalt", "copper", "dolomite", "epoxy", "flint", "garnet", "hematite",
    "ivory",
  ];
  return words
    .map((w, i) => `- decision entry number ${i} concerning ${w} and uniques ${w}${i} zz${i} qq${i} mm${i}`)
    .join("\n");
}

/** The spawn branch sits behind the capture early-return, so the host mock
 *  must return at least one message for the hook to reach Step 4c. */
function clientWithMessages(opts: { subSessionId?: string } = {}) {
  const client = mockHostClient({
    messages: [{
      info: { id: "m1", role: "user", sessionID: "s" },
      parts: [{ type: "text", text: "Build a REST API" }],
    }],
    subSessionId: opts.subSessionId,
  });
  return client;
}

describe("compacting Step-4c spawn branches", () => {
  let projectPath: string;
  let state: PluginState;

  beforeEach(() => {
    projectPath = tmpProject();
    state = createPluginState();
    fs.mkdirSync(path.join(projectPath, ".deep-memory"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, ".deep-memory", "MEMORY.md"), paddedMemory(), "utf8");
  });

  it("cooldown hit → session.create is NOT called, hook still completes", async () => {
    state.recordConsolidationAttempt(); // within the 60s cooldown window
    const client = clientWithMessages();
    const handler = createCompactingHandler({ client: client as never, state, projectPath });

    const output = { context: [] as string[] };
    await expect(handler({ sessionID: "sb-cool" }, output)).resolves.toBeUndefined();
    expect(client.session.create).not.toHaveBeenCalled();
    // The rest of the hook pipeline still ran.
    expect(output.context.length).toBeGreaterThan(0);
  });

  it("session.create rejects → error swallowed, hook completes", async () => {
    const client = clientWithMessages();
    (client.session.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("provider 503"));
    const handler = createCompactingHandler({ client: client as never, state, projectPath });

    const output = { context: [] as string[] };
    await expect(handler({ sessionID: "sb-reject" }, output)).resolves.toBeUndefined();
    expect(client.session.create).toHaveBeenCalledOnce();
    // PostCompact nudge + handoff still happened.
    expect(output.context.some((c) => c.includes("Prior conversation archived"))).toBe(true);
  });

  it("spawn success → bestModel forwarded in promptAsync, pending persisted", async () => {
    state.recordModel("sb-model", { providerID: "test-provider", modelID: "test-model-v9" });
    const client = clientWithMessages({ subSessionId: "sub-123" });
    const handler = createCompactingHandler({ client: client as never, state, projectPath });

    await handler({ sessionID: "sb-model" }, { context: [] });

    expect(client.session.create).toHaveBeenCalledOnce();
    expect(client.session.promptAsync).toHaveBeenCalledOnce();
    const body = (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(body.agent).toBe("general");
    expect(body.model).toEqual({ providerID: "test-provider", modelID: "test-model-v9" });
    // Pending consolidation recorded + persisted to project ROOT.
    const pendingFile = path.join(projectPath, ".pending-consolidation.json");
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect(fs.readFileSync(pendingFile, "utf8")).toContain("sub-123");
  });

  it("spawned sub-session compacting itself → no recursive spawn", async () => {
    const client = clientWithMessages();
    state.markSubSessionSpawned("sb-recursive");
    const handler = createCompactingHandler({ client: client as never, state, projectPath });

    await handler({ sessionID: "sb-recursive" }, { context: [] });
    expect(client.session.create).not.toHaveBeenCalled();
  });
});
