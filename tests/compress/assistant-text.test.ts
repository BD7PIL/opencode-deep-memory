import { describe, it, expect } from "vitest";
import {
  splitByCodeFences,
  compressPureProse,
  compressAssistantText,
} from "../../src/compress/single-pass.js";

function makeLongProse(minLines = 20): string {
  const lines = [
    "Here is the analysis of the problem.",
    "",
    "We need to consider several factors before proceeding.",
    "The first factor is performance.",
    "The second factor is readability.",
    "The third factor is maintainability.",
    "This is filler line that should be dropped during compression.",
    "Another filler line with no structural value at all.",
    "Yet another filler line that the compressor should remove.",
    "More filler content here without any keywords to keep.",
    "Even more filler that adds no information.",
    "Filler filler filler all the way down.",
    "Still going with the filler lines.",
    "Almost at the end of filler.",
    "Last filler line before the meaningful tail.",
    "- key conclusion one",
    "- key conclusion two",
    "## Summary",
    "The implementation should follow the pattern above.",
    "Final remarks about the approach.",
  ];
  while (lines.length < minLines) lines.push("additional filler line to pad length");
  return lines.join("\n");
}

describe("splitByCodeFences", () => {
  it("returns single prose segment when no fences", () => {
    const segs = splitByCodeFences("just prose\nno code here");
    expect(segs.length).toBe(1);
    expect(segs[0].type).toBe("prose");
    expect(segs[0].lines).toEqual(["just prose", "no code here"]);
  });

  it("splits prose-code-prose", () => {
    const text = "intro prose\n```ts\nconst x = 1;\n```\noutro prose";
    const segs = splitByCodeFences(text);
    expect(segs.map(s => s.type)).toEqual(["prose", "code", "prose"]);
    expect(segs[1].lines).toEqual(["```ts", "const x = 1;", "```"]);
  });

  it("handles code at start and end", () => {
    const text = "```ts\ncode1\n```\nprose\n```py\ncode2\n```";
    const segs = splitByCodeFences(text);
    expect(segs.map(s => s.type)).toEqual(["code", "prose", "code"]);
  });

  it("flushes trailing unterminated code as code segment", () => {
    const text = "prose\n```ts\nunfinished code";
    const segs = splitByCodeFences(text);
    expect(segs.map(s => s.type)).toEqual(["prose", "code"]);
    expect(segs[1].lines).toEqual(["```ts", "unfinished code"]);
  });

  it("handles multiple consecutive code blocks", () => {
    const text = "```ts\ncode1\n```\n```py\ncode2\n```";
    const segs = splitByCodeFences(text);
    expect(segs.map(s => s.type)).toEqual(["code", "code"]);
  });
});

describe("compressPureProse", () => {
  it("returns text unchanged when shorter than threshold", () => {
    const short = "short text";
    expect(compressPureProse(short)).toBe(short);
  });

  it("keeps head 3 and tail 3 lines", () => {
    const prose = makeLongProse();
    const result = compressPureProse(prose);
    const origLines = prose.split("\n");
    const resLines = result.split("\n");
    expect(resLines[0]).toBe(origLines[0]);
    expect(resLines[resLines.length - 1]).toBe(origLines[origLines.length - 1]);
  });

  it("keeps structural lines (headings, lists, errors)", () => {
    const prose = makeLongProse();
    const result = compressPureProse(prose);
    expect(result).toContain("## Summary");
    expect(result).toContain("- key conclusion one");
    expect(result).toContain("- key conclusion two");
  });

  it("drops non-structural middle lines", () => {
    const prose = makeLongProse();
    const result = compressPureProse(prose);
    expect(result.length).toBeLessThan(prose.length);
    expect(result).not.toContain("Filler filler filler all the way down.");
  });
});

describe("compressAssistantText", () => {
  it("returns short text unchanged", () => {
    expect(compressAssistantText("short")).toBe("short");
  });

  it("returns pure prose unchanged when below threshold", () => {
    const prose = "just a few lines\nof prose\nunder threshold";
    expect(compressAssistantText(prose)).toBe(prose);
  });

  it("compresses pure prose when above threshold", () => {
    const prose = makeLongProse(30);
    const result = compressAssistantText(prose);
    expect(result.length).toBeLessThan(prose.length);
  });

  it("preserves code blocks verbatim when text has mixed content", () => {
    const longProse1 = makeLongProse(20);
    const longProse2 = makeLongProse(20);
    const code = "```ts\nconst answer = 42;\nfunction foo() { return answer; }\n```";
    const text = `${longProse1}\n${code}\n${longProse2}`;

    const result = compressAssistantText(text);

    expect(result).toContain("const answer = 42;");
    expect(result).toContain("function foo() { return answer; }");
    expect(result).toContain("```ts");
    expect(result).toContain("```");
    expect(result.length).toBeLessThan(text.length);
  });

  it("returns original text when fences are unbalanced (defensive fallback)", () => {
    const prose = makeLongProse(20);
    const text = `${prose}\n\`\`\`ts\nconst x = 1;\n// closing fence missing`;
    expect(compressAssistantText(text)).toBe(text);
  });

  it("returns original text when compression ratio not met", () => {
    const text = "short\n\n" + "a".repeat(600);
    expect(compressAssistantText(text)).toBe(text);
  });

  it("handles multiple code blocks with prose between them", () => {
    const prose1 = makeLongProse(15);
    const prose2 = makeLongProse(15);
    const prose3 = makeLongProse(15);
    const code1 = "```ts\nconst a = 1;\n```";
    const code2 = "```py\nb = 2\n```";
    const text = `${prose1}\n${code1}\n${prose2}\n${code2}\n${prose3}`;

    const result = compressAssistantText(text);

    expect(result).toContain("const a = 1;");
    expect(result).toContain("b = 2");
    expect(result.length).toBeLessThan(text.length);
  });

  it("does not produce empty code blocks (regression for v0.8.6 bug)", () => {
    const prose = makeLongProse(20);
    const code = "```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```";
    const text = `${prose}\n${code}`;

    const result = compressAssistantText(text);

    const fenceMatches = result.match(/```ts\n[\s\S]*?\n```/);
    expect(fenceMatches).not.toBeNull();
    expect(fenceMatches![0]).toBe(code);
  });

  it("handles indented fence lines (leading whitespace)", () => {
    const prose = makeLongProse(20);
    const code = "  ```ts\n  const x = 1;\n  ```";
    const text = `${prose}\n${code}`;

    const result = compressAssistantText(text);

    expect(result).toContain("const x = 1;");
  });
});
