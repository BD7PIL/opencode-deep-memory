/**
 * Tests for checkpoint capture — fetch messages, write raw JSON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureMessages } from "../../src/extract/capture.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-capture-test-"));
}

function mockClient(messages: Array<{ info: unknown; parts: unknown[] }>) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
    },
  };
}

describe("captureMessages", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = tmpProject();
  });

  it("writes raw JSON checkpoint with correct structure", async () => {
    const messages = [
      {
        info: { id: "m1", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "s1" },
        parts: [{ type: "text", text: "hi there" }],
      },
    ];
    const client = mockClient(messages);

    const result = await captureMessages({
      client,
      sessionID: "s1",
      projectPath,
    });

    expect(result.messageCount).toBe(2);
    expect(result.rawFilePath).toBeTruthy();

    const raw = JSON.parse(fs.readFileSync(result.rawFilePath, "utf-8"));
    expect(raw.sessionID).toBe("s1");
    expect(raw.messageCount).toBe(2);
    expect(raw.messages).toHaveLength(2);
    expect(raw.capturedAt).toBeTruthy();
    expect(new Date(raw.capturedAt).toISOString()).toBe(raw.capturedAt);
  });

  it("returns empty result when SDK returns undefined data", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({ data: undefined }),
      },
    };

    const result = await captureMessages({
      client,
      sessionID: "s-empty",
      projectPath,
    });

    expect(result.messageCount).toBe(0);
    expect(result.rawFilePath).toBe("");
  });

  it("returns empty result when SDK returns empty array", async () => {
    const client = mockClient([]);

    const result = await captureMessages({
      client,
      sessionID: "s-empty",
      projectPath,
    });

    expect(result.messageCount).toBe(0);
    expect(result.rawFilePath).toBe("");
  });

  it("returns empty result when SDK call throws", async () => {
    const client = {
      session: {
        messages: vi.fn().mockRejectedValue(new Error("network error")),
      },
    };

    const result = await captureMessages({
      client,
      sessionID: "s-err",
      projectPath,
    });

    expect(result.messageCount).toBe(0);
    expect(result.rawFilePath).toBe("");
  });

  it("creates .deep-memory directory if it doesn't exist", async () => {
    const client = mockClient([
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    ]);

    const result = await captureMessages({
      client,
      sessionID: "s1",
      projectPath,
    });

    expect(fs.existsSync(result.rawFilePath)).toBe(true);
    expect(result.rawFilePath).toContain(".deep-memory");
  });

  it("passes sessionID to SDK client", async () => {
    const client = mockClient([
      { info: { role: "user" }, parts: [] },
    ]);

    await captureMessages({ client, sessionID: "sess-xyz", projectPath });

    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: "sess-xyz" },
    });
  });
});
