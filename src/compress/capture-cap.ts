/**
 * D3: Capture-time size caps. Applied ONCE when a tool result first appears,
 * not post-hoc on subsequent turns. See DESIGN_V4.md D3.
 *
 * Values from Cline's production output-limits.ts.
 */

export type ToolName = string;

export const DEFAULT_CAPS: Record<string, number> = {
  bash: 48_000,
  read: 50_000,
  grep: 10_000,
  glob: 10_000,
  task: 30_000,
  background_output: 30_000,
  webfetch: 20_000,
  generic: 40_000,
};

export interface CapResult {
  output: string;
  capped: boolean;
}

function truncateMiddle(content: string, maxChars: number, hint: string): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.45);
  const tailLen = Math.floor(maxChars * 0.40);
  const head = content.slice(0, headLen);
  const tail = content.slice(content.length - tailLen);
  return `${head}\n\n[... truncated — ${hint} ...]\n\n${tail}`;
}

function hintFor(tool: string): string {
  switch (tool) {
    case "bash":
      return "use grep or read with offset for specifics";
    case "read":
      return "re-read with offset parameter for the omitted section";
    case "grep":
    case "search":
      return "narrow your search pattern for fewer results";
    case "webfetch":
      return "the full page was larger than the cap";
    default:
      return "output was capped at capture time";
  }
}

export function capToolOutput(
  content: string,
  tool: ToolName,
  opts?: { cap?: number },
): CapResult {
  const limit = opts?.cap ?? DEFAULT_CAPS[tool] ?? DEFAULT_CAPS.generic;
  if (content.length <= limit) {
    return { output: content, capped: false };
  }
  return { output: truncateMiddle(content, limit, hintFor(tool)), capped: true };
}
