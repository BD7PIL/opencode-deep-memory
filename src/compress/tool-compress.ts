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
};

const DEFAULT_HEAD_LINES = 50;
const DEFAULT_TAIL_LINES = 20;
const MAX_LINE_LENGTH = 500;

export function compressToolOutput(toolName: string, output: string): string {
  if (!output || output.length < 500) return output;

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
