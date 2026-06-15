/**
 * Tool factory barrel — exports all memory tools.
 */

import type { SearchService } from "../search/service.js";
import { createMemorySearchTool } from "./memory-search.js";
import { createMemoryStoreTool } from "./memory-store.js";
import { createMemoryForgetTool } from "./memory-forget.js";

/**
 * Create all memory tools bound to a shared SearchService.
 */
export function createMemoryTools(service: SearchService) {
  return {
    memory_search: createMemorySearchTool(service),
    memory_store: createMemoryStoreTool(service),
    memory_forget: createMemoryForgetTool(service),
  };
}

export { createMemorySearchTool } from "./memory-search.js";
export { createMemoryStoreTool } from "./memory-store.js";
export { createMemoryForgetTool } from "./memory-forget.js";
