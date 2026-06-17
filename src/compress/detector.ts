export type ContentType = "json" | "code" | "log" | "text" | "error-trace" | "diff" | "html";

export function detectContentType(content: string): ContentType {
  const trimmed = content.trimStart();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(content); return "json"; } catch { /* not json */ }
  }

  if (/^diff --git |^@@ -\d+,\d+ \+\d+,\d+ @@|^[+-]{3} \//m.test(content)) return "diff";

  if (/Traceback \(most recent call last\)|at \S+\.\S+\(|Error: |Exception: |TypeError: |ReferenceError: /m.test(content)) return "error-trace";

  if (/<[a-z][\s\S]*>/i.test(content) && /<(html|div|span|body|head|script|style)[\s>]/i.test(content)) return "html";

  const lines = content.split("\n");
  const logLineCount = lines.filter(l => /^\s*(\d{4}-\d{2}-\d{2}|\[\d{4}|ERROR\b|WARN\b|INFO\b|DEBUG\b|FATAL\b|TRACE\b)/.test(l)).length;
  if (lines.length > 5 && logLineCount / lines.length > 0.3) return "log";

  const codePatterns = /\b(function |class |def |import |from .+ import|const |let |var |export |interface |type |struct |fn |func |pub |private |protected )\b/;
  const codeLines = lines.filter(l => codePatterns.test(l)).length;
  if (lines.length > 10 && codeLines / lines.length > 0.15) return "code";

  return "text";
}
