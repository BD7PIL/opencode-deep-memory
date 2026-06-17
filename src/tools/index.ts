import type { SearchService } from "../search/service.js";
import type { PluginState } from "../hooks/shared-state.js";
import { tool } from "@opencode-ai/plugin";
import { createMemorySearchTool } from "./memory-search.js";
import { createMemoryStoreTool } from "./memory-store.js";
import { createMemoryForgetTool } from "./memory-forget.js";
import { createMemoryExpandTool } from "./memory-expand.js";
import { ccrRetrieve } from "../compress/ccr.js";

export function createMemoryTools(
  service: SearchService,
  opts?: { projectPath?: string },
) {
  const search = createMemorySearchTool(service);
  const store = createMemoryStoreTool(service);
  const forget = createMemoryForgetTool(service);
  const expand = opts?.projectPath
    ? createMemoryExpandTool({ projectPath: opts.projectPath })
    : createMemoryExpandTool({ projectPath: "" });

  return {
    memory_search: search,
    memory_store: store,
    memory_forget: forget,
    memory_expand: expand,
  };
}

export function createDeepExpandTool(state: PluginState) {
  return tool({
    description: "Retrieve original content that was previously compressed. Use hash from [ccr:...] markers.",
    args: {
      hash: tool.schema.string().describe("The hash from the [ccr:HASH] marker"),
    },
    execute: async (args) => {
      const original = ccrRetrieve(state, args.hash);
      if (original) return { title: "Expanded content", output: original };
      return { title: "Not found", output: "Content expired or hash not found." };
    },
  });
}

export { createMemorySearchTool } from "./memory-search.js";
export { createMemoryStoreTool } from "./memory-store.js";
export { createMemoryForgetTool } from "./memory-forget.js";
export { createMemoryExpandTool } from "./memory-expand.js";
