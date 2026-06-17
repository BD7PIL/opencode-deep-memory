import { describe, it, expect } from "vitest";
import { detectMemoryNudge, buildMemoryNudge } from "../../src/compress/memory-nudge.js";

function msg(role: string, text: string) {
  return { info: { role }, parts: [{ type: "text", text }] };
}

function toolError() {
  return {
    info: { role: "assistant" as const },
    parts: [
      { type: "tool" as const, state: { status: "error", error: "something failed" } },
      { type: "text" as const, text: "I see the error, let me fix it" },
    ],
  };
}

const INF = Number.POSITIVE_INFINITY;

describe("detectMemoryNudge", () => {
  describe("cooldown", () => {
    it("returns no nudge when within cooldown (messagesSince < 3)", () => {
      const messages = [
        msg("user", "use PostgreSQL because it supports JSON"),
        msg("assistant", "I decided to use PostgreSQL for the database"),
        msg("user", "ok"),
      ];
      expect(detectMemoryNudge(messages as never, 0)).toEqual({ injected: false, type: null });
      expect(detectMemoryNudge(messages as never, 2)).toEqual({ injected: false, type: null });
    });

    it("triggers nudge when cooldown expired (messagesSince >= 3)", () => {
      const messages = [
        msg("user", "use PostgreSQL because it supports JSON"),
        msg("assistant", "I decided to use PostgreSQL for the database"),
        msg("user", "ok"),
      ];
      expect(detectMemoryNudge(messages as never, 3)).toEqual({ injected: true, type: "decision" });
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "decision" });
    });
  });

  describe("decision patterns", () => {
    it("detects English decision keywords", () => {
      const messages = [
        msg("user", "which database?"),
        msg("assistant", "I'll use PostgreSQL because it has good JSON support"),
        msg("user", "sounds good"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "decision" });
    });

    it("detects Chinese decision keywords (no \\b boundary issue)", () => {
      const messages = [
        msg("user", "用什么数据库？"),
        msg("assistant", "我决定采用PostgreSQL作为主数据库"),
        msg("user", "好的"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "decision" });
    });

    it("detects 选用 in Chinese", () => {
      const messages = [
        msg("user", "框架选哪个？"),
        msg("assistant", "确定选用Vite作为构建工具"),
        msg("user", "可以"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "decision" });
    });

    it("detects decision from user message (symmetric filtering)", () => {
      const messages = [
        msg("user", "I chose React for the frontend"),
        msg("assistant", "好的，我会用React来构建前端"),
        msg("user", "ok"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "decision" });
    });
  });

  describe("constraint patterns", () => {
    it("detects English constraint from user", () => {
      const messages = [
        msg("user", "You must not use eval() in production code"),
        msg("assistant", "I'll avoid eval and use safer alternatives"),
        msg("user", "good"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "constraint" });
    });

    it("detects Chinese constraint (no \\b boundary issue)", () => {
      const messages = [
        msg("user", "不能在生产环境用eval函数"),
        msg("assistant", "明白了，我会用其他方式实现"),
        msg("user", "好的"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "constraint" });
    });

    it("detects constraint from assistant message (symmetric filtering)", () => {
      const messages = [
        msg("user", "how should we handle auth?"),
        msg("assistant", "We must not store tokens in localStorage, always use httpOnly cookies"),
        msg("user", "ok"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "constraint" });
    });
  });

  describe("gotcha patterns", () => {
    it("detects error fix after tool error", () => {
      const messages = [
        toolError(),
        msg("assistant", "I fixed the permission error by adding chmod +x"),
        msg("user", "great"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "gotcha" });
    });

    it("detects Chinese error fix (no \\b boundary issue)", () => {
      const messages = [
        toolError(),
        msg("assistant", "修复了权限问题，原因是文件没有执行权限"),
        msg("user", "谢谢"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: true, type: "gotcha" });
    });

    it("does not trigger gotcha without recent tool error", () => {
      const messages = [
        msg("user", "run the tests"),
        msg("assistant", "I fixed the test by updating the assertion"),
        msg("user", "ok"),
      ];
      const result = detectMemoryNudge(messages as never, INF);
      expect(result.type).not.toBe("gotcha");
    });
  });

  describe("no false positives", () => {
    it("returns no nudge for normal conversation", () => {
      const messages = [
        msg("user", "what is the weather today?"),
        msg("assistant", "I don't have access to weather data"),
        msg("user", "ok"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: false, type: null });
    });

    it("returns no nudge for short messages", () => {
      const messages = [
        msg("user", "yes"),
        msg("assistant", "ok"),
        msg("user", "thanks"),
      ];
      expect(detectMemoryNudge(messages as never, INF)).toEqual({ injected: false, type: null });
    });
  });
});

describe("buildMemoryNudge", () => {
  it("builds gotcha nudge", () => {
    expect(buildMemoryNudge("gotcha")).toContain("memory_store(type=\"gotcha\")");
  });

  it("builds constraint nudge", () => {
    expect(buildMemoryNudge("constraint")).toContain("memory_store(type=\"constraint\")");
  });

  it("builds decision nudge", () => {
    expect(buildMemoryNudge("decision")).toContain("memory_store(type=\"decision\")");
  });

  it("returns empty string for unknown type", () => {
    expect(buildMemoryNudge("unknown")).toBe("");
  });
});
