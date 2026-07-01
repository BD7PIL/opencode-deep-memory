import { describe, it, expect } from "vitest";
import { capToolOutput, DEFAULT_CAPS } from "../../src/compress/capture-cap.js";

describe("capToolOutput (D3 capture-time caps)", () => {
  it("returns original when under cap", () => {
    const result = capToolOutput("short output", "bash");
    expect(result.capped).toBe(false);
    expect(result.output).toBe("short output");
  });

  it("caps bash output exceeding 48K with recovery hint", () => {
    const big = "line\n".repeat(15000); // ~75KB
    const result = capToolOutput(big, "bash");
    expect(result.capped).toBe(true);
    expect(result.output.length).toBeLessThan(big.length);
    expect(result.output).toContain("grep");
    expect(result.output).not.toContain(big);
  });

  it("caps read output exceeding 50K with recovery hint", () => {
    const big = "x".repeat(60000);
    const result = capToolOutput(big, "read");
    expect(result.capped).toBe(true);
    expect(result.output.length).toBeLessThan(60000);
    expect(result.output).toContain("offset");
  });

  it("does NOT cap outputs under threshold", () => {
    const result = capToolOutput("x".repeat(40000), "bash");
    expect(result.capped).toBe(false);
  });

  it("preserves head and tail in capped output", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`);
    const big = lines.join("\n");
    const result = capToolOutput(big, "bash");
    if (result.capped) {
      expect(result.output).toContain("line-0");
      expect(result.output).toContain("line-999");
    }
  });

  it("handles unknown tool names with generic cap", () => {
    const big = "x".repeat(60000);
    const result = capToolOutput(big, "unknownTool");
    expect(result.capped).toBe(true);
    expect(result.output.length).toBeLessThan(big.length);
  });

  it("respects custom cap override", () => {
    const result = capToolOutput("x".repeat(200), "bash", { cap: 100 });
    expect(result.capped).toBe(true);
    expect(result.output.length).toBeLessThan(200);
  });

  it("DEFAULT_CAPS has expected values (Cline pattern)", () => {
    expect(DEFAULT_CAPS.bash).toBe(48000);
    expect(DEFAULT_CAPS.read).toBe(50000);
    expect(DEFAULT_CAPS.webfetch).toBe(20000);
  });
});
