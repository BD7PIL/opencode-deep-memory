import { detectContentType } from "./detector.js";

const TOOL_COMPRESS_STRATEGIES: Record<string, (output: string) => string> = {
  read: compressFileRead,
  bash: compressBash,
  grep: compressSearchResults,
  glob: compressGlob,
  ripgrep: compressSearchResults,
  rg: compressSearchResults,
  find: compressGlob,
  search: compressSearchResults,
  grep_app_searchGitHub: compressSearchResults,
  searxng_searxng_web_search: compressSearchResults,
  websearch_web_search_exa: compressSearchResults,
  tavily_tavily_search: compressSearchResults,
  background_output: compressAgentOutput,
  task: compressAgentOutput,
  skill: compressSkillOutput,
  session_read: compressAgentOutput,
  webfetch: compressAgentOutput,
};

const DEFAULT_HEAD_LINES = 50;
const DEFAULT_TAIL_LINES = 20;
const MAX_LINE_LENGTH = 500;

export function compressToolOutput(toolName: string, output: string): string {
  if (!output || output.length < 200) return output;

  const strategy = TOOL_COMPRESS_STRATEGIES[toolName];
  if (strategy) return strategy(output);

  return compressGeneric(output);
}

function compressFileRead(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 100) return output;

  const head = lines.slice(0, DEFAULT_HEAD_LINES);
  const tail = lines.slice(-DEFAULT_TAIL_LINES);
  const keyLines = extractKeyLines(lines.slice(DEFAULT_HEAD_LINES, -DEFAULT_TAIL_LINES));

  const parts = [...head, "...[truncated]", ...keyLines.slice(0, 10), "...[truncated]", ...tail];
  return parts.join("\n");
}

function compressBash(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 50) return output;

  const errorLines = lines.filter(l => /error|fail|exception|fatal|panic/i.test(l)).slice(0, 5);
  const tail = lines.slice(-30);

  return [...errorLines, ...tail].join("\n");
}

function compressSearchResults(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 30) return output;

  const grouped = groupByFile(lines);
  const result: string[] = [];
  let count = 0;

  for (const [file, matches] of grouped) {
    if (count >= 20) break;
    result.push(`--- ${file} ---`);
    const kept = matches.slice(0, 5);
    for (const m of kept) {
      result.push(truncateLine(m, MAX_LINE_LENGTH));
      count++;
    }
    if (matches.length > 5) result.push(`  ...[${matches.length - 5} more matches]`);
  }

  if (count >= 20 && lines.length > 30) {
    result.push(`\n...[${lines.length - count} more lines truncated]`);
  }

  return result.join("\n");
}

function compressGlob(output: string): string {
  const lines = output.split("\n").filter(l => l.trim());
  if (lines.length <= 30) return output;

  const head = lines.slice(0, 30);
  return [...head, `\n...[${lines.length - 30} more files]`].join("\n");
}

function compressGeneric(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 50) {
    if (output.length <= 2000) return output;
    return output.slice(0, 1500) + "\n...[truncated]" + output.slice(-500);
  }

  const head = lines.slice(0, 30);
  const tail = lines.slice(-15);
  const errorLines = lines.filter(l => /error|fail|exception|fatal/i.test(l)).slice(0, 5);

  return [...head, "...[truncated]", ...errorLines, "...[truncated]", ...tail].join("\n");
}

function extractKeyLines(lines: string[]): string[] {
  return lines.filter(l =>
    /\b(function |class |def |import |export |interface |type |const |let |var |return |throw |Error|Exception)\b/.test(l) ||
    /error|warn|fail|exception/i.test(l)
  );
}

function groupByFile(lines: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let currentFile = "unknown";

  for (const line of lines) {
    const fileMatch = line.match(/^(\/[^\s:]+):/);
    if (fileMatch) {
      currentFile = fileMatch[1];
    }
    if (!groups.has(currentFile)) groups.set(currentFile, []);
    groups.get(currentFile)!.push(line);
  }

  return groups;
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 15) + "...[truncated]";
}

function compressJsonOutput(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return compressJsonArray(parsed);
    }
    if (typeof parsed === "object" && parsed !== null) {
      return compressJsonObject(parsed);
    }
    return output;
  } catch {
    return output;
  }
}

function compressJsonArray(arr: unknown[]): string {
  const head = 30;
  const tail = 15;
  const maxItems = 50;
  if (arr.length <= maxItems) return JSON.stringify(arr, null, 2);
  const kept = [...arr.slice(0, head), { _truncated: true, total: arr.length }, ...arr.slice(-tail)];
  return JSON.stringify(kept, null, 2);
}

function compressJsonObject(obj: Record<string, unknown>): string {
  const MAX_CHILD_ITEMS = 30;
  let modified = false;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > MAX_CHILD_ITEMS) {
      result[key] = {
        _truncated: true,
        total: value.length,
        items: [...value.slice(0, 10), toStringPlaceholder(value.slice(10, 20)), ...value.slice(-10)],
      };
      modified = true;
    } else {
      result[key] = value;
    }
  }

  if (modified) {
    return JSON.stringify(result, null, 2);
  }
  return JSON.stringify(obj, null, 2);
}

function toStringPlaceholder(items: unknown[]): Record<string, number> {
  return { _skipped: items.length };
}

function compressAgentOutput(output: string): string {
  if (detectContentType(output) === "json") {
    return compressJsonOutput(output);
  }

  const lines = output.split("\n");
  if (lines.length <= 40 && output.length <= 3000) return output;

  const MAX_SECTION_LINES = 5;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("[ccr:") || line.includes("[superseded")) {
      result.push(line);
      continue;
    }

    const isHeader = /^#{1,4}\s/.test(line) || /^---/.test(line) || /^\*\*$/.test(line);
    const hasCode = line.includes("```");
    const hasKey = /\b(error|fail|success|completed|result|summary|warning)\b/i.test(line);

    if (isHeader || hasCode || hasKey) {
      result.push(truncateLine(line, 300));
      continue;
    }

    if (i < 5 || i >= lines.length - 10) {
      result.push(truncateLine(line, 300));
      continue;
    }

    const inSection = result.length > 0 && result[result.length - 1] !== "";
    if (!inSection) {
      if (line.trim()) {
        result.push(line);
      }
    } else {
      const recentLines = result.slice(-MAX_SECTION_LINES).filter(l => l.trim() && l !== "...");
      if (recentLines.length >= MAX_SECTION_LINES) {
        result.push("...[truncated]");
        while (i < lines.length && !/^#{1,4}\s/.test(lines[i]) && !lines[i].includes("```") && !/\b(error|fail|summary)\b/i.test(lines[i])) {
          i++;
        }
        i--;
      } else {
        result.push(truncateLine(line, 300));
      }
    }
  }

  return result.join("\n");
}

function compressSkillOutput(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 60 && output.length <= 4000) return output;

  const result: string[] = [];
  const FRONTMATTER_END = lines.findIndex((l, i) => i > 0 && l.trim() === "---");

  for (let i = 0; i < lines.length; i++) {
    if (i <= FRONTMATTER_END || i < 10) {
      result.push(lines[i]);
      continue;
    }
    if (i >= lines.length - 10) {
      result.push(lines[i]);
      continue;
    }

    const line = lines[i];
    if (/^#{1,4}\s/.test(line) || /^```/.test(line) || /^---/.test(line)) {
      result.push(line);
      continue;
    }
    if (/\b(must|must not|required|forbidden|never|always)\b/i.test(line)) {
      result.push(line);
      continue;
    }

    const recentNonEmpty = result.slice(-8).filter(l => l.trim());
    if (recentNonEmpty.length >= 8 && !result[result.length - 1].startsWith("...")) {
      result.push("...[truncated]");
      while (i < lines.length && !/^#{1,4}\s/.test(lines[i]) && !/^```/.test(lines[i])) {
        i++;
      }
      i--;
    } else {
      result.push(line);
    }
  }

  if (result.length < lines.length * 0.7) {
    return result.join("\n");
  }
  return output;
}
