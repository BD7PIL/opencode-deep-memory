import { describe, it, expect } from "vitest";
import {
  projectSubdir,
  resolveGlobalRoot,
  projectMemoryDir,
  globalMemoryDir,
  scopeDir,
  memoryFilePath,
  scheduleFilePath,
  indexStateFilePath,
  checkpointRawPath,
  sessionCheckpointDir,
  hashProject,
} from "../../src/shared/paths.js";

describe("paths: projectSubdir", () => {
  it("defaults to .deep-memory", () => {
    expect(projectSubdir({})).toBe(".deep-memory");
  });

  it("respects DEEP_MEMORY_PROJECT_SUBDIR env override", () => {
    expect(projectSubdir({ DEEP_MEMORY_PROJECT_SUBDIR: ".mem" })).toBe(".mem");
  });
});

describe("paths: resolveGlobalRoot", () => {
  it("uses DEEP_MEMORY_GLOBAL_ROOT when set", () => {
    expect(resolveGlobalRoot({ DEEP_MEMORY_GLOBAL_ROOT: "/tmp/g" })).toBe("/tmp/g");
  });

  it("uses DEEP_MEMORY_DATA legacy alias when set", () => {
    expect(resolveGlobalRoot({ DEEP_MEMORY_DATA: "/tmp/legacy" })).toBe("/tmp/legacy");
  });

  it("uses XDG_DATA_HOME when set", () => {
    const result = resolveGlobalRoot({ XDG_DATA_HOME: "/tmp/xdg" });
    expect(result).toContain("opencode");
    expect(result).toContain("deep-memory");
  });

  it("falls back to homedir/.local/share/opencode/deep-memory", () => {
    const result = resolveGlobalRoot({});
    expect(result).toContain(".local");
    expect(result).toContain("opencode");
    expect(result).toContain("deep-memory");
  });

  it("DEEP_MEMORY_GLOBAL_ROOT takes priority over DEEP_MEMORY_DATA", () => {
    expect(resolveGlobalRoot({ DEEP_MEMORY_GLOBAL_ROOT: "/tmp/g", DEEP_MEMORY_DATA: "/tmp/d" }))
      .toBe("/tmp/g");
  });
});

describe("paths: projectMemoryDir", () => {
  it("joins projectPath with default subdir", () => {
    const dir = projectMemoryDir("/my/project");
    expect(dir).toContain("/my/project");
    expect(dir).toContain(".deep-memory");
  });
});

describe("paths: globalMemoryDir", () => {
  it("appends 'global' to resolveGlobalRoot", () => {
    const dir = globalMemoryDir();
    expect(dir).toContain("global");
  });
});

describe("paths: scopeDir", () => {
  it("returns projectMemoryDir for project scope", () => {
    const dir = scopeDir("project", "/proj");
    expect(dir).toContain("/proj");
    expect(dir).toContain(".deep-memory");
  });

  it("returns session dir for session scope", () => {
    const dir = scopeDir("session", "/proj", "sess-123");
    expect(dir).toContain("sessions");
    expect(dir).toContain("sess-123");
  });

  it("throws for session scope without sessionID", () => {
    expect(() => scopeDir("session", "/proj")).toThrow("sessionID");
  });
});

describe("paths: memoryFilePath", () => {
  it("returns MEMORY.md for memory type", () => {
    expect(memoryFilePath("project", "memory", "/proj").endsWith("MEMORY.md")).toBe(true);
  });

  it("returns notes.md for notes type", () => {
    expect(memoryFilePath("project", "notes", "/proj").endsWith("notes.md")).toBe(true);
  });

  it("returns checkpoint.md for checkpoint type", () => {
    expect(memoryFilePath("project", "checkpoint", "/proj").endsWith("checkpoint.md")).toBe(true);
  });
});

describe("paths: scheduleFilePath / indexStateFilePath / checkpointRawPath", () => {
  it("scheduleFilePath joins project dir", () => {
    expect(scheduleFilePath("/proj")).toContain(".schedule.json");
  });

  it("indexStateFilePath joins project dir", () => {
    expect(indexStateFilePath("/proj")).toContain(".index-state.json");
  });

  it("checkpointRawPath joins project dir", () => {
    expect(checkpointRawPath("/proj", "sess")).toContain("checkpoint.raw.json");
  });
});

describe("paths: sessionCheckpointDir", () => {
  it("returns per-session directory", () => {
    const dir = sessionCheckpointDir("/proj", "sess-1");
    expect(dir).toContain("sessions");
    expect(dir).toContain("sess-1");
  });
});

describe("paths: hashProject", () => {
  it("returns a 16-char hex string", () => {
    expect(hashProject("/some/path")).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic for same input", () => {
    expect(hashProject("/some/path")).toBe(hashProject("/some/path"));
  });

  it("differs for different inputs", () => {
    expect(hashProject("/path/a")).not.toBe(hashProject("/path/b"));
  });
});
