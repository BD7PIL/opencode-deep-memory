import { z } from "zod";

/**
 * Local `tool` helper.
 *
 * Upstream's `@opencode-ai/plugin` exports `tool = (input) => input` with
 * `tool.schema = z`. Importing that package at runtime made a **directory**
 * install fail in an air-gapped host (`Cannot find package
 * '@opencode-ai/plugin'`). Bundling the two-line helper — and zod with it —
 * makes this package genuinely zero-runtime-dependency, so the same tree loads
 * by package name or by directory.
 *
 * The signature mirrors upstream's `tool.d.ts` so tool definitions keep their
 * argument/context inference.
 */

export type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  /** Current project directory for this session. */
  directory: string;
  /** Project worktree root. */
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export type ToolAttachment = {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
};

export type ToolResult =
  | string
  | {
    title?: string;
    output: string;
    metadata?: Record<string, unknown>;
    attachments?: ToolAttachment[];
  };

const toolFn = <Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}): typeof input => input;

export const tool = Object.assign(toolFn, { schema: z });
