/**
 * v1 tool map -> v2 tool registry.
 *
 * v1 declares tools as a `{[name]: ToolDefinition}` map on the returned hooks
 * object. v2 has no such field: tools reach the agent only through
 * `ctx.tool.transform(editor => editor.add(...))`, and only when
 * `options.namespace` is set — a tool added without a namespace lands in the
 * registry but never appears in the agent's tool list. Both facts were
 * re-verified against 2.0.32 (docs/research/v2-032-respike.md §3).
 *
 * v2 composes the LLM-facing name as `${namespace}_${name}`, so splitting the
 * v1 key on its first underscore reproduces the v1 name byte for byte:
 * `memory_search` -> namespace "memory" + name "search". Keeping the bare
 * names matters because the frozen TOOL_HINT in the system prompt tells the
 * agent to call `memory_search(...)`, `memory_store(...)` and friends; a
 * prefixed name would silently invalidate that guidance.
 */
import { tool } from "@opencode-ai/plugin";
import type { V2ToolEditor, V2ToolInfo } from "./v2-types.js";

/** A v1 tool definition as this codebase builds it. */
export interface V1ToolDefinition {
  description?: string;
  args?: Record<string, unknown>;
  execute?: (args: any, context?: unknown) => unknown;
}

/** zod ships inside the peer dependency; reach it through `tool.schema`. */
type ZodLike = {
  object?: (shape: Record<string, unknown>) => unknown;
  toJSONSchema?: (schema: unknown) => Record<string, unknown>;
};

/**
 * Convert a v1 zod arg shape into the JSON Schema v2 expects on `tool.input`.
 *
 * Falls back to a permissive object schema when the peer's zod build cannot be
 * introspected, so a zod upgrade degrades to "the model sees no parameters"
 * rather than a tool that fails to register.
 */
export function toV2ToolInput(args: unknown): Record<string, unknown> {
  const zod = (tool as unknown as { schema?: ZodLike }).schema;
  if (!args || typeof args !== "object" || !zod?.object || !zod.toJSONSchema) {
    return { type: "object", properties: {} };
  }
  try {
    const json = zod.toJSONSchema(zod.object(args as Record<string, unknown>));
    const out: Record<string, unknown> = { ...json };
    delete out["$schema"];
    // v1 never declared closed objects; stay permissive so an extra key from
    // the model is not a hard validation failure.
    delete out["additionalProperties"];
    const properties = (out["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(out["required"])) {
      // A field carrying a default is optional on the wire, whatever zod inferred.
      out["required"] = (out["required"] as string[]).filter(
        (key) => !(key in properties && properties[key] && "default" in properties[key]),
      );
    }
    return out;
  } catch {
    return { type: "object", properties: {} };
  }
}

/**
 * Normalize a v1 tool result into the v2 `{output}` contract.
 *
 * v1 tools return either a bare string or `{title, output}`; v2 results carry
 * the text on `output` and have no title field, so a v1 title is folded into
 * metadata rather than dropped.
 */
export function toV2ToolResult(result: unknown): { output: string; metadata?: Record<string, unknown> } {
  if (typeof result === "string") return { output: result };
  if (result && typeof result === "object") {
    const rec = result as { output?: unknown; title?: unknown };
    const output =
      typeof rec.output === "string" ? rec.output : rec.output === undefined || rec.output === null ? "" : String(rec.output);
    return typeof rec.title === "string" && rec.title
      ? { output, metadata: { title: rec.title } }
      : { output };
  }
  return { output: result === undefined || result === null ? "" : String(result) };
}

/**
 * Split a v1 tool key into the v2 (namespace, name) pair that reproduces it.
 *
 * Names without a usable separator fall back to a single namespace so they
 * still reach the agent.
 */
export function splitToolName(v1Name: string): { namespace: string; name: string } {
  const idx = v1Name.indexOf("_");
  if (idx <= 0 || idx === v1Name.length - 1) {
    return { namespace: "deepmemory", name: v1Name };
  }
  return { namespace: v1Name.slice(0, idx), name: v1Name.slice(idx + 1) };
}

/**
 * Register every v1 tool on the v2 editor and return how many were added.
 *
 * The host re-runs the transform callback on reload (twice in one observed
 * 2.0.32 session), so registration is driven purely by the input map and
 * carries no accumulating state.
 */
export function registerV2Tools(editor: V2ToolEditor, tools: Record<string, V1ToolDefinition>): number {
  let added = 0;
  for (const [v1Name, definition] of Object.entries(tools)) {
    if (!definition || typeof definition !== "object") continue;
    const { namespace, name } = splitToolName(v1Name);
    const info: V2ToolInfo = {
      name,
      description: definition.description ?? v1Name,
      input: toV2ToolInput(definition.args),
      output: { type: "object", properties: { output: { type: "string" } } },
      options: { namespace, codemode: false },
      execute: async (input: unknown) => {
        const result = definition.execute ? await definition.execute(input, undefined) : "";
        return toV2ToolResult(result);
      },
    };
    editor.add(info);
    added += 1;
  }
  return added;
}