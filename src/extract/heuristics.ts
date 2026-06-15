/**
 * Heuristic extraction — 5 pattern-matching extractors for checkpoint knowledge.
 *
 * No LLM calls. Pure regex + structural analysis on message parts.
 * Designed for the "instant layer" of dual-layer extraction (DESIGN.md §5.2).
 */

import { truncateToTokenBudget } from "../shared/tokens.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal message shape consumed by extractors. */
export interface MessageInput {
  info: { role: string };
  parts: PartInput[];
}

/** Minimal part shape — covers text, tool-call, and tool-result variants. */
export interface PartInput {
  type: string;
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  output?: unknown;
  state?: { status?: string; output?: string; error?: string };
}

export interface HeuristicResult {
  userIntents: string[];
  decisions: string[];
  constraints: string[];
  gotchas: Array<{ error: string; fix: string }>;
  fileChanges: Array<{ path: string; operation: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECISION_RE =
  /\b(I'll|I will|I recommend|let's|we should)\b|(建议|决定|采用|方案)/i;

const CONSTRAINT_RE =
  /\b(must not|never|do not)\b|(不要|必须|绝不能|避免)/i;

const GOTCHA_ERROR_RE = /^(error|failed|cannot|unable)/i;

const BASH_FILE_OP_RE = /\b(?:write|edit|create|delete|mv|cp|rm)\s+(\S+)/;

/**
 * Split text into sentences (by . ! ? and CJK equivalents).
 * Returns trimmed non-empty sentences.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Find the sentence in `text` that contains `re`.
 * Returns the full sentence or undefined.
 */
function findMatchingSentence(text: string, re: RegExp): string | undefined {
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (re.test(sentence)) return sentence;
  }
  // Fallback: if no sentence boundary found, check the whole text
  if (re.test(text)) return text.trim();
  return undefined;
}

/**
 * Get the output string from a tool part.
 * Handles both state.output (ToolStateCompleted) and direct output field.
 */
function getToolOutput(part: PartInput): string {
  if (part.state?.output) return part.state.output;
  if (typeof part.output === "string") return part.output;
  if (part.output && typeof part.output === "object") {
    return JSON.stringify(part.output);
  }
  return "";
}

/**
 * Get the error string from a tool part.
 * Handles both state.error (ToolStateError) and output matching error pattern.
 */
function getToolError(part: PartInput): string | undefined {
  if (part.state?.status === "error" && part.state.error) return part.state.error;
  const out = getToolOutput(part);
  if (out && GOTCHA_ERROR_RE.test(out)) return out.slice(0, 300);
  return undefined;
}

// ---------------------------------------------------------------------------
// Pattern 1: User Intents
// ---------------------------------------------------------------------------

function extractUserIntents(messages: MessageInput[]): string[] {
  const intents: string[] = [];
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    // Concatenate text parts, skip tool results
    const text = msg.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
    if (!text.trim()) continue;
    const truncated = truncateToTokenBudget(text, 200);
    intents.push(truncated);
  }
  return intents;
}

// ---------------------------------------------------------------------------
// Pattern 2: Decisions
// ---------------------------------------------------------------------------

function extractDecisions(messages: MessageInput[]): string[] {
  const seen = new Set<string>();
  const decisions: string[] = [];

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "text" || !part.text) continue;
      const sentence = findMatchingSentence(part.text, DECISION_RE);
      if (sentence && !seen.has(sentence)) {
        seen.add(sentence);
        decisions.push(sentence);
      }
    }
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Pattern 3: Constraints
// ---------------------------------------------------------------------------

function extractConstraints(messages: MessageInput[]): string[] {
  const seen = new Set<string>();
  const constraints: string[] = [];

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "text" || !part.text) continue;
      const sentence = findMatchingSentence(part.text, CONSTRAINT_RE);
      if (sentence && !seen.has(sentence)) {
        seen.add(sentence);
        constraints.push(sentence);
      }
    }
  }
  return constraints;
}

// ---------------------------------------------------------------------------
// Pattern 4: Gotchas (error → fix pairs)
// ---------------------------------------------------------------------------

function extractGotchas(
  messages: MessageInput[],
): Array<{ error: string; fix: string }> {
  const gotchas: Array<{ error: string; fix: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const parts = messages[i]!.parts;
    for (const part of parts) {
      if (part.type !== "tool") continue;
      const errorMsg = getToolError(part);
      if (!errorMsg) continue;

      // Look ahead 1-3 messages for a corrective action
      const fix = findCorrectiveAction(messages, i + 1, 3);
      if (fix) {
        gotchas.push({ error: errorMsg.slice(0, 200), fix });
      }
    }
  }
  return gotchas;
}

/**
 * Scan the next `windowSize` messages starting at `startIdx` for a
 * corrective tool call (write, edit, bash) after an error.
 */
function findCorrectiveAction(
  messages: MessageInput[],
  startIdx: number,
  windowSize: number,
): string | undefined {
  const end = Math.min(startIdx + windowSize, messages.length);
  for (let j = startIdx; j < end; j++) {
    for (const part of messages[j]!.parts) {
      if (part.type !== "tool") continue;
      if (!part.tool) continue;
      const toolName = part.tool.toLowerCase();
      if (toolName === "write" || toolName === "edit") {
        const filePath =
          (part.args?.filePath as string) || (part.args?.path as string) || "";
        return `${toolName} ${filePath}`.trim();
      }
      if (toolName === "bash" || toolName === "execute") {
        const cmd = (part.args?.command as string) || "";
        if (cmd) return `bash: ${cmd.slice(0, 120)}`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pattern 5: File Changes
// ---------------------------------------------------------------------------

function extractFileChanges(
  messages: MessageInput[],
): Array<{ path: string; operation: string }> {
  const changes: Array<{ path: string; operation: string }> = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || !part.tool) continue;
      const tool = part.tool.toLowerCase();

      if (tool === "write" || tool === "edit") {
        const filePath =
          (part.args?.filePath as string) || (part.args?.path as string) || "";
        if (filePath) {
          const key = `${filePath}:${tool}`;
          if (!seen.has(key)) {
            seen.add(key);
            changes.push({ path: filePath, operation: tool });
          }
        }
      } else if (tool === "bash" || tool === "execute") {
        const cmd = (part.args?.command as string) || "";
        const match = BASH_FILE_OP_RE.exec(cmd);
        if (match?.[1]) {
          const key = `${match[1]}:bash`;
          if (!seen.has(key)) {
            seen.add(key);
            changes.push({ path: match[1], operation: "bash" });
          }
        }
      }
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run all 5 heuristic extractors on a message array.
 *
 * Returns a complete HeuristicResult with empty arrays when no patterns match.
 */
export function extractHeuristics(messages: MessageInput[]): HeuristicResult {
  return {
    userIntents: extractUserIntents(messages),
    decisions: extractDecisions(messages),
    constraints: extractConstraints(messages),
    gotchas: extractGotchas(messages),
    fileChanges: extractFileChanges(messages),
  };
}
