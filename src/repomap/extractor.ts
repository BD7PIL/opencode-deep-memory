/**
 * Regex-based symbol extractor for repo map generation.
 * Zero dependencies — pure regex, no tree-sitter.
 */

export interface ExtractedSymbol {
  name: string;
  type: string;
  line: number;
}

// ── Language detection ──────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
};

export function getLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

// ── Per-language patterns ───────────────────────────────────────────────────

interface PatternDef {
  type: string;
  re: RegExp;
}

function buildPatterns(lang: string): PatternDef[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return [
        // exported/named function declarations
        { type: "function", re: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g },
        // arrow/const functions: export const foo = (...) =>
        { type: "function", re: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/g },
        // class declarations
        { type: "class", re: /(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/g },
        // interface declarations
        { type: "interface", re: /(?:export\s+)?interface\s+(\w+)/g },
        // type alias declarations
        { type: "type", re: /(?:export\s+)?type\s+(\w+)/g },
        // enum declarations
        { type: "enum", re: /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g },
        // method definitions inside classes (indented)
        { type: "method", re: /^[ \t]+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm },
        // top-level const (non-function)
        { type: "const", re: /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?!(?:async\s+)?(?:\(|[a-zA-Z_]\w*\s*=>))/g },
      ];

    case "python":
      return [
        { type: "function", re: /^\s*def\s+(\w+)\s*\(/gm },
        { type: "class", re: /^\s*class\s+(\w+)/gm },
      ];

    case "go":
      return [
        // func (receiver) MethodName — method
        { type: "method", re: /^func\s+\([^)]+\)\s+(\w+)\s*\(/gm },
        // func FunctionName — free function
        { type: "function", re: /^func\s+(\w+)\s*\(/gm },
        // type Foo struct
        { type: "struct", re: /^type\s+(\w+)\s+struct\b/gm },
        // type Foo interface
        { type: "interface", re: /^type\s+(\w+)\s+interface\b/gm },
      ];

    case "rust":
      return [
        { type: "function", re: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g },
        { type: "struct", re: /(?:pub\s+)?struct\s+(\w+)/g },
        { type: "enum", re: /(?:pub\s+)?enum\s+(\w+)/g },
        { type: "trait", re: /(?:pub\s+)?trait\s+(\w+)/g },
        { type: "type", re: /(?:pub\s+)?type\s+(\w+)/g },
        { type: "const", re: /(?:pub\s+)?const\s+(\w+)\s*:/g },
      ];

    case "java":
      return [
        { type: "class", re: /(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g },
        { type: "interface", re: /(?:public\s+)?interface\s+(\w+)/g },
        { type: "enum", re: /(?:public\s+)?enum\s+(\w+)/g },
        // methods (public/private/protected return-type name(...)
        { type: "method", re: /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/g },
      ];

    case "c":
    case "cpp":
      return [
        // function definitions: return_type name(...)  {
        { type: "function", re: /^(?:[\w*\s]+?)\b(\w+)\s*\([^)]*\)\s*\{/gm },
        { type: "struct", re: /^struct\s+(\w+)/gm },
        { type: "class", re: /^class\s+(\w+)/gm },
        { type: "enum", re: /^enum\s+(\w+)/gm },
      ];

    case "ruby":
      return [
        { type: "function", re: /(?:^|\s)def\s+(\w+[!?]?)/gm },
        { type: "class", re: /(?:^|\s)class\s+(\w+)/gm },
        { type: "module", re: /(?:^|\s)module\s+(\w+)/gm },
      ];

    default:
      return [];
  }
}

// ── Extraction ──────────────────────────────────────────────────────────────

/** Build a line-offset table for converting byte offsets to line numbers. */
function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Binary-search the offset table to find the 1-based line number. */
function offsetToLine(offset: number, lineOffsets: number[]): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

export function extractSymbols(
  filePath: string,
  content: string,
): ExtractedSymbol[] {
  const lang = getLanguage(filePath);
  if (!lang) return [];

  const patterns = buildPatterns(lang);
  const lineOffsets = buildLineOffsets(content);
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  for (const { type, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      // Group 1 always holds the symbol name for our patterns
      const name = m[1];
      if (!name) continue;

      const key = `${type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const line = offsetToLine(m.index, lineOffsets);
      symbols.push({ name, type, line });
    }
  }

  return symbols;
}
