import { describe, it, expect } from "vitest";
import { formatRepoMap } from "../../src/repomap/injector.js";

describe("formatRepoMap", () => {
  it("formats entries with XML tags", () => {
    const result = formatRepoMap([
      { file: "src/auth.ts", symbols: ["login", "logout"] },
      { file: "src/db.ts", symbols: ["connect", "query"] },
    ]);
    expect(result).toBe(
      "<deep-memory-repomap>\n" +
      "src/auth.ts: login, logout\n" +
      "src/db.ts: connect, query\n" +
      "</deep-memory-repomap>",
    );
  });

  it("returns empty string for empty entries", () => {
    expect(formatRepoMap([])).toBe("");
  });

  it("handles single file entry", () => {
    const result = formatRepoMap([
      { file: "src/utils.ts", symbols: ["formatDate"] },
    ]);
    expect(result).toBe(
      "<deep-memory-repomap>\n" +
      "src/utils.ts: formatDate\n" +
      "</deep-memory-repomap>",
    );
  });
});
