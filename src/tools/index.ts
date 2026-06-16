/**
 * Tool factory barrel — exports all memory tools.
 */

import type { SearchService } from "../search/service.js";
import { createMemorySearchTool } from "./memory-search.js";
import { createMemoryStoreTool } from "./memory-store.js";
import { createMemoryForgetTool } from "./memory-forget.js";
import { createMemoryExpandTool } from "./memory-expand.js";

/**
 * Create all memory tools bound to a shared SearchService.
 *
 * @param service - shared search service for search/store/forget
 * @param opts - optional config; pass `projectPath` to enable the memory_expand tool
 */
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

export { createMemorySearchTool } from "./memory-search.js";
export { createMemoryStoreTool } from "./memory-store.js";
export { createMemoryForgetTool } from "./memory-forget.js";
export { createMemoryExpandTool } from "./memory-expand.js";
