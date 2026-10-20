import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*-types.ts"],
      // Hard floor — only ratchets up. Raise a number together with the tests
      // that raised it; never lower one to make a red build green. Measured at
      // 2026-10-21: statements 85.41 / branches 81.76 / functions 90.4 — the
      // gaps below are margin for refactors that add yet-uncovered paths.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 88,
        lines: 85,
      },
    },
  },
});
