/**
 * Tests for agent-budget — classifyAgent and budgetFor.
 */
import { describe, it, expect } from "vitest";
import { classifyAgent, budgetFor } from "../../src/inject/agent-budget.js";
import type { AgentTier } from "../../src/inject/agent-budget.js";

describe("classifyAgent", () => {
  it("classifies undefined as main", () => {
    expect(classifyAgent(undefined)).toBe("main");
  });

  it.each(["build", "sisyphus", "open-craft", "opencode"])(
    "classifies '%s' as main",
    (agent) => {
      expect(classifyAgent(agent)).toBe("main");
    },
  );

  it("is case-insensitive for main agents", () => {
    expect(classifyAgent("Build")).toBe("main");
    expect(classifyAgent("SISYPHUS")).toBe("main");
    expect(classifyAgent("Open-Craft")).toBe("main");
  });

  it.each(["oracle", "metis", "momus"])(
    "classifies '%s' as deep-reasoning",
    (agent) => {
      expect(classifyAgent(agent)).toBe("deep-reasoning");
    },
  );

  it("is case-insensitive for deep-reasoning agents", () => {
    expect(classifyAgent("Oracle")).toBe("deep-reasoning");
    expect(classifyAgent("METIS")).toBe("deep-reasoning");
  });

  it.each(["explore", "librarian", "quick", "task", "Sisyphus-Junior", "general"])(
    "classifies '%s' as tool-subagent",
    (agent) => {
      expect(classifyAgent(agent)).toBe("tool-subagent");
    },
  );

  it("is case-insensitive for tool-subagent agents", () => {
    expect(classifyAgent("Explore")).toBe("tool-subagent");
    expect(classifyAgent("LIBRARIAN")).toBe("tool-subagent");
    expect(classifyAgent("sisyphus-junior")).toBe("tool-subagent");
  });

  it("defaults unknown agents to main", () => {
    expect(classifyAgent("unknown-agent")).toBe("main");
    expect(classifyAgent("custom-bot")).toBe("main");
  });
});

describe("budgetFor", () => {
  describe("normal mode", () => {
    it("returns correct budget for main tier", () => {
      const budget = budgetFor("main", "normal");
      expect(budget).toEqual({
        total: 800,
        toolPrompt: 80,
        memorySummary: 400,
        checkpointSummary: 220,
        repomap: 100,
      });
    });

    it("returns correct budget for deep-reasoning tier", () => {
      const budget = budgetFor("deep-reasoning", "normal");
      expect(budget).toEqual({
        total: 400,
        toolPrompt: 80,
        memorySummary: 240,
        checkpointSummary: 80,
        repomap: 0,
      });
    });

    it("returns correct budget for tool-subagent tier", () => {
      const budget = budgetFor("tool-subagent", "normal");
      expect(budget).toEqual({
        total: 80,
        toolPrompt: 80,
        memorySummary: 0,
        checkpointSummary: 0,
        repomap: 0,
      });
    });
  });

  describe("post-compaction mode", () => {
    it("returns expanded budget for main tier", () => {
      const budget = budgetFor("main", "post-compaction");
      expect(budget).toEqual({
        total: 3000,
        toolPrompt: 80,
        memorySummary: 1200,
        checkpointSummary: 1420,
        repomap: 300,
      });
    });

    it("returns expanded budget for deep-reasoning tier", () => {
      const budget = budgetFor("deep-reasoning", "post-compaction");
      expect(budget).toEqual({
        total: 800,
        toolPrompt: 80,
        memorySummary: 500,
        checkpointSummary: 220,
        repomap: 0,
      });
    });

    it("returns same budget for tool-subagent tier", () => {
      const budget = budgetFor("tool-subagent", "post-compaction");
      expect(budget).toEqual({
        total: 80,
        toolPrompt: 80,
        memorySummary: 0,
        checkpointSummary: 0,
        repomap: 0,
      });
    });
  });

  describe("post-resume mode", () => {
    it("returns same as post-compaction for main tier", () => {
      const resume = budgetFor("main", "post-resume");
      const compaction = budgetFor("main", "post-compaction");
      expect(resume).toEqual(compaction);
    });

    it("returns same as normal for deep-reasoning tier", () => {
      const resume = budgetFor("deep-reasoning", "post-resume");
      const normal = budgetFor("deep-reasoning", "normal");
      expect(resume).toEqual(normal);
    });

    it("returns same as normal for tool-subagent tier", () => {
      const resume = budgetFor("tool-subagent", "post-resume");
      const normal = budgetFor("tool-subagent", "normal");
      expect(resume).toEqual(normal);
    });
  });

  it("budget components sum to total for all tiers and modes", () => {
    const tiers: AgentTier[] = ["main", "deep-reasoning", "tool-subagent"];
    const modes = ["normal", "post-compaction", "post-resume"] as const;

    for (const tier of tiers) {
      for (const mode of modes) {
        const budget = budgetFor(tier, mode);
        expect(budget.toolPrompt + budget.memorySummary + budget.checkpointSummary + budget.repomap).toBe(
          budget.total,
        );
      }
    }
  });
});
