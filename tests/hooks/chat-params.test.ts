/**
 * Tests for chat-params hook handler.
 */
import { describe, it, expect } from "vitest";
import { createChatParamsHandler } from "../../src/hooks/chat-params.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("createChatParamsHandler", () => {
  it("records agent mapping from chat.params input", async () => {
    const state = createPluginState();
    const handler = createChatParamsHandler(state);

    const input = {
      sessionID: "sess-abc",
      agent: "build",
      model: { id: "test-model" } as any,
      provider: {} as any,
      message: {} as any,
    };
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };

    await handler(input, output);

    expect(state.agentOf("sess-abc")).toBe("build");
  });

  it("overwrites previous agent mapping for same sessionID", async () => {
    const state = createPluginState();
    const handler = createChatParamsHandler(state);

    const makeInput = (agent: string) => ({
      sessionID: "sess-1",
      agent,
      model: { id: "test-model" } as any,
      provider: {} as any,
      message: {} as any,
    });
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };

    await handler(makeInput("build"), output);
    expect(state.agentOf("sess-1")).toBe("build");

    await handler(makeInput("oracle"), output);
    expect(state.agentOf("sess-1")).toBe("oracle");
  });

  it("tracks multiple sessions independently", async () => {
    const state = createPluginState();
    const handler = createChatParamsHandler(state);

    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };

    await handler(
      {
        sessionID: "sess-1",
        agent: "build",
        model: {} as any,
        provider: {} as any,
        message: {} as any,
      },
      output,
    );
    await handler(
      {
        sessionID: "sess-2",
        agent: "explore",
        model: {} as any,
        provider: {} as any,
        message: {} as any,
      },
      output,
    );

    expect(state.agentOf("sess-1")).toBe("build");
    expect(state.agentOf("sess-2")).toBe("explore");
  });
});
