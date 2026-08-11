/**
 * Regression: consolidation/compression sub-sessions hardcoded `agent: "general"`
 * without a model override, causing OpenCode to route to the general agent's model
 * (which may be unsupported, e.g. xiaomi/mimo-v2.5-pro-ultraspeed → 400 error).
 *
 * Fix: all spawn sites now pass `model: state.bestModel()` in the promptAsync body,
 * overriding the agent's model routing. This test verifies the model is actually
 * forwarded to the SDK call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompactingHandler } from "../../src/hooks/compacting.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-model-override-"));
}

function mockClient(messages: Array<{ info: unknown; parts: unknown[] }>) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
      create: vi.fn().mockResolvedValue({ data: { id: "mock-sub-model-test" } }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeMessages(count: number): Array<{ info: unknown; parts: unknown[] }> {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", sessionID: "s1" },
      parts: [{ type: "text", text: `Message ${i} content with enough text to be captured` }],
    });
  }
  return msgs;
}

describe("Model override in promptAsync (P0.5 fix)", () => {
  let projectPath: string;
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    projectPath = tmpProject();
    state = createPluginState();
  });

  it("passes bestModel() in promptAsync body when spawning consolidation sub-session", async () => {
    // Set up: 50+ line MEMORY.md to trigger consolidation spawn
    const memDir = path.join(projectPath, ".deep-memory");
    fs.mkdirSync(memDir, { recursive: true });
    const lines = Array.from({ length: 55 }, (_, i) => `Memory line ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), lines, "utf8");

    // Record a fallback model (simulates config.get() callback)
    state.recordFallbackModel({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "parent-sess" }, output);

    // Verify promptAsync was called
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    // Verify model is in the body
    const callArgs = client.session.promptAsync.mock.calls[0][0];
    expect(callArgs.body.model).toBeDefined();
    expect(callArgs.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    // Agent should still be "general" (for tool set / system prompt)
    expect(callArgs.body.agent).toBe("general");
  });

  it("omits model when bestModel() returns undefined (graceful degradation)", async () => {
    // Set up: 50+ line MEMORY.md
    const memDir = path.join(projectPath, ".deep-memory");
    fs.mkdirSync(memDir, { recursive: true });
    const lines = Array.from({ length: 55 }, (_, i) => `Memory line ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), lines, "utf8");

    // DON'T record any model — bestModel() returns undefined
    expect(state.bestModel()).toBeUndefined();

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "parent-sess" }, output);

    // promptAsync should still fire (falls back to agent's model)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    const callArgs = client.session.promptAsync.mock.calls[0][0];
    // model should not be set (spread conditional omitted it)
    expect(callArgs.body.model).toBeUndefined();
    expect(callArgs.body.agent).toBe("general");
  });

  it("prefers projectModel over fallbackModel", async () => {
    const memDir = path.join(projectPath, ".deep-memory");
    fs.mkdirSync(memDir, { recursive: true });
    const lines = Array.from({ length: 55 }, (_, i) => `Memory line ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), lines, "utf8");

    // Both models set — projectModel should win
    state.recordFallbackModel({ providerID: "fallback-provider", modelID: "fallback-model" });
    state.recordModel("parent-sess", { providerID: "project-provider", modelID: "project-model" });

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "parent-sess" }, output);

    const callArgs = client.session.promptAsync.mock.calls[0][0];
    expect(callArgs.body.model).toEqual({ providerID: "project-provider", modelID: "project-model" });
  });
});
