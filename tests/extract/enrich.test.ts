/**
 * Tests for the idle-layer LLM enrichment executor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEnrichment } from "../../src/extract/enrich.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-enrich-test-"));
}

function writeRawJson(projectPath: string, sessionID: string, ageMs = 0): void {
  const dir = path.join(projectPath, ".deep-memory");
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, "checkpoint.raw.json");
  fs.writeFileSync(rawPath, JSON.stringify({ sessionID, messages: [] }));

  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(rawPath, past, past);
  }
}

function writeCheckpointMd(projectPath: string): void {
  const dir = path.join(projectPath, ".deep-memory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "checkpoint.md"), "# Checkpoint — s1\n\nSome content.");
}

function mockClient(overrides?: { createThrows?: boolean; promptAsyncThrows?: boolean }) {
  const sessionCreate = vi.fn();
  const sessionPromptAsync = vi.fn();

  if (overrides?.createThrows) {
    sessionCreate.mockRejectedValue(new Error("create failed"));
  } else {
    sessionCreate.mockResolvedValue({ data: { id: "enrich-session-123" } });
  }

  if (overrides?.promptAsyncThrows) {
    sessionPromptAsync.mockRejectedValue(new Error("prompt failed"));
  }

  return {
    session: {
      create: sessionCreate,
      promptAsync: sessionPromptAsync,
    },
  };
}

describe("runEnrichment", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = tmpProject();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it("returns spawned when both files exist and raw is fresh", async () => {
    writeRawJson(projectPath, "s1");
    writeCheckpointMd(projectPath);
    const client = mockClient();

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("spawned");
    expect(result.sessionID).toBe("enrich-session-123");
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("returns skipped when checkpoint.raw.json is missing", async () => {
    writeCheckpointMd(projectPath);
    const client = mockClient();

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("skipped");
    expect(result.sessionID).toBe("");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("returns skipped when checkpoint.md is missing", async () => {
    writeRawJson(projectPath, "s1");
    const client = mockClient();

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("skipped");
    expect(result.sessionID).toBe("");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("returns skipped when checkpoint.raw.json is older than 10 minutes", async () => {
    writeRawJson(projectPath, "s1", 11 * 60 * 1000);
    writeCheckpointMd(projectPath);
    const client = mockClient();

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("skipped");
    expect(result.sessionID).toBe("");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("returns failed when client.session.create throws", async () => {
    writeRawJson(projectPath, "s1");
    writeCheckpointMd(projectPath);
    const client = mockClient({ createThrows: true });

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("failed");
    expect(result.sessionID).toBe("");
  });

  it("returns failed when client.session.promptAsync throws", async () => {
    writeRawJson(projectPath, "s1");
    writeCheckpointMd(projectPath);
    const client = mockClient({ promptAsyncThrows: true });

    const result = await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    expect(result.status).toBe("failed");
    expect(result.sessionID).toBe("");
  });

  it("substitutes template variables in the prompt", async () => {
    writeRawJson(projectPath, "s1");
    writeCheckpointMd(projectPath);
    const client = mockClient();

    await runEnrichment({
      client: client as never,
      projectPath,
      sessionID: "s1",
    });

    const promptArg = client.session.promptAsync.mock.calls[0]?.[0];
    expect(promptArg).toBeDefined();
    const text = promptArg.body.parts[0].text as string;
    expect(text).not.toContain("{{checkpointPath}}");
    expect(text).not.toContain("{{rawPath}}");
    expect(text).not.toContain("{{projectPath}}");
    expect(text).not.toContain("{{ISO timestamp}}");
    expect(text).toContain("checkpoint.md");
    expect(text).toContain("checkpoint.raw.json");
    expect(text).toContain(projectPath);
  });
});
