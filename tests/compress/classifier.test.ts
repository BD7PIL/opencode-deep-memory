import { describe, it, expect } from "vitest";
import { classifyForCompression } from "../../src/compress/classifier.js";

describe("P1: classifyForCompression", () => {
  it("preserves protected tools (edit, memory_store, etc)", () => {
    expect(classifyForCompression("edit", "", undefined)).toBe("preserve");
    expect(classifyForCompression("memory_store", "", undefined)).toBe("preserve");
    expect(classifyForCompression("question", "", undefined)).toBe("preserve");
    expect(classifyForCompression("context_compress", "", undefined)).toBe("preserve");
  });

  it("marks bash/grep/glob as transient", () => {
    expect(classifyForCompression("bash", "output", undefined)).toBe("transient");
    expect(classifyForCompression("grep", "output", undefined)).toBe("transient");
    expect(classifyForCompression("glob", "output", undefined)).toBe("transient");
  });

  it("marks unknown tools as summarize", () => {
    expect(classifyForCompression("webfetch", "output", undefined)).toBe("summarize");
    expect(classifyForCompression("read", "output", undefined)).toBe("summarize");
  });

  it("marks read of edited files as stale", () => {
    const output = "src/index.ts\nsome content\n";
    const recentlyEdited = new Set(["src/index.ts"]);
    expect(classifyForCompression("read", output, recentlyEdited)).toBe("stale");
  });

  it("marks read of unedited files as summarize", () => {
    const output = "src/other.ts\nsome content\n";
    const recentlyEdited = new Set(["src/index.ts"]);
    expect(classifyForCompression("read", output, recentlyEdited)).toBe("summarize");
  });
});
