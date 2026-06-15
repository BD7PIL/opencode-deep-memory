/**
 * Tests for chat-message hook — keyword detection and notes.md capture.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatMessageHandler } from "../../src/hooks/chat-message.js";
import type { UserMessage } from "@opencode-ai/sdk";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
}

function makeUserInput(sessionID: string, agent?: string) {
  return {
    sessionID,
    ...(agent ? { agent } : {}),
  };
}

function makeUserMessage(sessionID: string): UserMessage {
  return {
    id: "msg-" + Math.random().toString(36).slice(2, 8),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4o" },
  };
}

function makeAssistantMessage(sessionID: string) {
  return {
    id: "msg-" + Math.random().toString(36).slice(2, 8),
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4o" },
  };
}

function makeTextParts(text: string) {
  return [
    {
      id: "part-" + Math.random().toString(36).slice(2, 8),
      sessionID: "sess",
      messageID: "msg",
      type: "text" as const,
      text,
    },
  ];
}

function findFileRecursive(dir: string, name: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === name) return full;
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, name);
        if (found) return found;
      }
    }
  } catch {
    // ignore permission errors
  }
  return null;
}

describe("chat-message hook", () => {
  let tmp: string;
  let dataDir: string;
  const origEnv = process.env.DEEP_MEMORY_DATA;

  beforeEach(() => {
    tmp = tmpDir();
    dataDir = path.join(tmp, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.DEEP_MEMORY_DATA = dataDir;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.DEEP_MEMORY_DATA;
    } else {
      process.env.DEEP_MEMORY_DATA = origEnv;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("captures Chinese keyword '记住' to notes.md", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-abc12345-xyz";
    await handler(
      makeUserInput(sid),
      { message: makeUserMessage(sid), parts: makeTextParts("记住这个决策") },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).not.toBeNull();
    const content = fs.readFileSync(notesFile!, "utf8");
    expect(content).toContain("记住这个决策");
    expect(content).toContain("##");
    expect(content).toContain("session sess-abc");
  });

  it("captures English keyword 'remember' to notes.md", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-def67890-abc";
    await handler(
      makeUserInput(sid),
      { message: makeUserMessage(sid), parts: makeTextParts("remember to do X") },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).not.toBeNull();
    const content = fs.readFileSync(notesFile!, "utf8");
    expect(content).toContain("remember to do X");
  });

  it("does NOT create file when no keyword matches", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-ghi11111-aaa";
    await handler(
      makeUserInput(sid),
      { message: makeUserMessage(sid), parts: makeTextParts("hello world") },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).toBeNull();
  });

  it("does NOT capture assistant messages even with keywords", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-jkk22222-bbb";
    const output = {
      message: makeAssistantMessage(sid) as unknown as UserMessage,
      parts: makeTextParts("remember this important decision"),
    };
    await handler(makeUserInput(sid), output);

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).toBeNull();
  });

  it("truncates messages longer than 500 chars", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const longText = "a".repeat(600) + " remember " + "b".repeat(600);
    const sid = "sess-lll33333-ccc";
    await handler(
      makeUserInput(sid),
      { message: makeUserMessage(sid), parts: makeTextParts(longText) },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).not.toBeNull();
    const content = fs.readFileSync(notesFile!, "utf8");
    expect(content).toContain("[truncated]");
    // The text portion should be at most 500 chars + the marker
    const textMatch = content.match(/## .+\n(.+)/);
    expect(textMatch).not.toBeNull();
    const textLine = textMatch![1];
    expect(textLine.length).toBeLessThanOrEqual(500 + " [truncated]".length);
  });

  it("appends only ONCE when multiple keywords match", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-mmm44444-ddd";
    await handler(
      makeUserInput(sid),
      { message: makeUserMessage(sid), parts: makeTextParts("记住 important: must not forget") },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).not.toBeNull();
    const content = fs.readFileSync(notesFile!, "utf8");
    // Should have exactly one ## heading (one append)
    const headings = content.match(/^## /gm);
    expect(headings).toHaveLength(1);
  });

  it("two separate messages with keywords produce two appends", async () => {
    const handler = createChatMessageHandler({ projectPath: tmp });

    const sid1 = "sess-nnn55555-eee";
    await handler(
      makeUserInput(sid1),
      { message: makeUserMessage(sid1), parts: makeTextParts("remember first") },
    );
    const sid2 = "sess-ooo66666-fff";
    await handler(
      makeUserInput(sid2),
      { message: makeUserMessage(sid2), parts: makeTextParts("记住 second") },
    );

    const notesFile = findFileRecursive(tmp, "notes.md");
    expect(notesFile).not.toBeNull();
    const content = fs.readFileSync(notesFile!, "utf8");
    expect(content).toContain("remember first");
    expect(content).toContain("记住 second");
    const headings = content.match(/^## /gm);
    expect(headings).toHaveLength(2);
  });

  it("does not throw when data directory is read-only", async () => {
    fs.chmodSync(dataDir, 0o555);

    const handler = createChatMessageHandler({ projectPath: tmp });
    const sid = "sess-ppp77777-ggg";
    const output = {
      message: makeUserMessage(sid),
      parts: makeTextParts("remember this"),
    };

    // Must not throw
    await expect(handler(makeUserInput(sid), output)).resolves.toBeUndefined();

    fs.chmodSync(dataDir, 0o755);
  });
});
