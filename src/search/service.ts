/**
 * Search service: ties together Reconciler, BM25Index, and tokenizer.
 *
 * Provides a high-level API for searching, storing, and removing memory entries.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { acquireLock } from "../shared/lock.js";
import { memoryFilePath } from "../shared/paths.js";
import type { Scope, MemoryType } from "../shared/paths.js";
import type { Logger } from "../shared/log.js";
import { BM25Index } from "./bm25.js";
import { Reconciler } from "./reconcile.js";
import { tokenizeQuery } from "./tokenizer.js";
import { extractEntities, ENTITY_BOOST_WEIGHT } from "../shared/entity-extract.js";

/** A search result with full context. */
export interface SearchResult {
  docId: string;
  filePath: string;
  scope: Scope;
  heading: string;
  snippet: string;
  score: number;
  matchedTerms: string[];
}

/** Options for constructing a SearchService. */
export interface SearchServiceOptions {
  dataRoot: string;
  projectPath: string;
  logger?: Logger;
}

/**
 * High-level search service for persistent memory.
 */
export class SearchService {
  private readonly dataRoot: string;
  private readonly projectPath: string;
  private readonly logger?: Logger;
  private readonly index: BM25Index;
  private readonly reconciler: Reconciler;
  private initialized = false;
  private _searchCache = new Map<string, { results: SearchResult[]; mtime: number }>();
  private static readonly SEARCH_CACHE_MAX = 50;

  constructor(opts: SearchServiceOptions) {
    this.dataRoot = opts.dataRoot;
    this.projectPath = opts.projectPath;
    this.logger = opts.logger;
    this.index = new BM25Index();
    this.reconciler = new Reconciler({
      dataRoot: opts.dataRoot,
      projectPath: opts.projectPath,
      index: this.index,
    });
  }

  get project(): string {
    return this.projectPath;
  }

  /**
   * Ensure the index is initialized. Lazy — calls Reconciler.sync() on first call.
   */
  async ensureIndex(): Promise<void> {
    if (this.initialized) return;
    const result = await this.reconciler.sync();
    this.logger?.debug("Index initialized", {
      added: result.added,
      modified: result.modified,
      removed: result.removed,
    });
    this.initialized = true;
  }

  /**
   * Search the memory index.
   *
   * @param query - Search query (supports `|` for OR-join)
   * @param opts.scope - Filter results to this scope ("all" = no filter)
   * @param opts.limit - Max results to return (default 5)
   */
  async search(
    query: string,
    opts?: { scope?: Scope | "all"; limit?: number; applyDecay?: boolean },
  ): Promise<SearchResult[]> {
    await this.ensureIndex();

    const scope = opts?.scope ?? "all";
    const limit = opts?.limit ?? 5;
    const applyDecay = opts?.applyDecay ?? false;

    // Cache check: keyed by query+scope+limit+applyDecay, invalidated by MEMORY.md mtime change
    const memMtime = this.getSearchCacheMtime();
    const cacheKey = `${query}::${scope}::${limit}::${applyDecay}`;
    const cached = this._searchCache.get(cacheKey);
    if (cached && cached.mtime === memMtime) {
      return cached.results;
    }

    const queryPhrases = tokenizeQuery(query);
    if (queryPhrases.length === 0) return [];

    // Flatten all query tokens for BM25 search (OR semantics across phrases)
    const allQueryTokens: string[] = [];
    for (const phrase of queryPhrases) {
      for (const token of phrase) {
        if (!allQueryTokens.includes(token)) allQueryTokens.push(token);
      }
    }

    const rawResults = this.index.search(allQueryTokens, {
      limit: limit * 3, // Over-fetch for scope filtering
      applyDecay: opts?.applyDecay,
    });
    // G2 (Mem0): entity-boosted re-ranking — results matching query entities get score boost
    const queryEntities = extractEntities(query);
    if (queryEntities.length > 0 && rawResults.length > 0) {
      for (const raw of rawResults) {
        // Extract entities from the result's matched terms + docId
        const docText = raw.docId + " " + [...raw.matchedTerms].join(" ");
        const docEntities = extractEntities(docText);
        if (docEntities.length > 0) {
          const docEntitySet = new Set(docEntities);
          const hasOverlap = queryEntities.some((e) => docEntitySet.has(e));
          if (hasOverlap) {
            raw.score *= ENTITY_BOOST_WEIGHT;
          }
        }
      }
      // Re-sort after boost
      rawResults.sort((a, b) => b.score - a.score);
    }

    const results: SearchResult[] = [];
    for (const raw of rawResults) {
      const parsed = this.parseDocId(raw.docId);
      if (!parsed) continue;

      // Scope filter
      if (scope !== "all" && parsed.scope !== scope) continue;

      // Read source file for snippet
      const snippet = await this.extractSnippet(
        parsed.filePath,
        parsed.heading,
        raw.matchedTerms,
      );

      results.push({
        docId: raw.docId,
        filePath: parsed.filePath,
        scope: parsed.scope,
        heading: parsed.heading,
        snippet,
        score: raw.score,
        matchedTerms: raw.matchedTerms,
      });

      if (results.length >= limit) break;
    }

    // Cache write: store results with current mtime for future cache hits
    if (this._searchCache.size >= SearchService.SEARCH_CACHE_MAX) {
      const oldestKey = this._searchCache.keys().next().value;
      if (oldestKey) this._searchCache.delete(oldestKey);
    }
    this._searchCache.set(cacheKey, { results, mtime: memMtime });

    return results;
  }

  /**
   * Get the max mtime of project + global MEMORY.md for cache invalidation.
   */
  private getSearchCacheMtime(): number {
    let mtime = 0;
    try {
      const { statSync } = require("node:fs");
      const projPath = memoryFilePath("project", "memory", this.projectPath);
      mtime = Math.max(mtime, statSync(projPath).mtimeMs);
    } catch { /* file may not exist */ }
    try {
      const { statSync } = require("node:fs");
      const { globalMemoryDir } = require("../shared/paths.js");
      const globalPath = require("node:path").join(globalMemoryDir(), "MEMORY.md");
      mtime = Math.max(mtime, statSync(globalPath).mtimeMs);
    } catch { /* global may not exist */ }
    return mtime;
  }

  /**
   * Add a memory entry to a markdown file.
   *
   * Appends content as a bullet point under `## [Type]` heading.
   * Triggers incremental index update.
   */
  async addEntry(
    scope: Scope,
    type: MemoryType,
    section: string,
    content: string,
  ): Promise<void> {
    await this.ensureIndex();

    const filePath = memoryFilePath(
      scope,
      type,
      this.projectPath,
      undefined,
      this.dataRoot,
    );

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Format the entry
    const heading = `## ${section}`;
    const entry = `- ${content.trim()}`;

    // Acquire lock and append
    const release = await acquireLock(filePath);
    try {
      let existing = "";
      if (existsSync(filePath)) {
        existing = await fs.readFile(filePath, "utf8");
      }

      // Check if heading exists
      const headingIdx = existing.indexOf(heading);
      if (headingIdx !== -1) {
        // Find the end of this section (next ## heading or end of file)
        const afterHeading = existing.indexOf("\n## ", headingIdx + heading.length);
        if (afterHeading !== -1) {
          // Insert before next heading
          const before = existing.slice(0, afterHeading);
          const after = existing.slice(afterHeading);
          const newContent = before + "\n" + entry + "\n" + after;
          await fs.writeFile(filePath, newContent, "utf8");
        } else {
          // Append at end
          const newContent = existing.trimEnd() + "\n" + entry + "\n";
          await fs.writeFile(filePath, newContent, "utf8");
        }
      } else {
        // Create heading section
        const newContent = existing.trimEnd() + "\n\n" + heading + "\n" + entry + "\n";
        await fs.writeFile(filePath, newContent, "utf8");
      }
    } finally {
      release();
    }

    // Incremental index update: re-index this file
    const reconciler = new Reconciler({
      dataRoot: this.dataRoot,
      projectPath: this.projectPath,
      index: this.index,
    });
    // Force re-index by running sync (will detect mtime change)
    await reconciler.sync();
  }

  /**
   * Remove memory entries matching a query.
   *
   * Returns the number of entries removed.
   */
  async removeEntry(
    scope: Scope,
    type: MemoryType,
    query: string,
  ): Promise<{ removed: number }> {
    await this.ensureIndex();

    const filePath = memoryFilePath(
      scope,
      type,
      this.projectPath,
      undefined,
      this.dataRoot,
    );

    if (!existsSync(filePath)) return { removed: 0 };

    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return { removed: 0 };

    const release = await acquireLock(filePath);
    let removed = 0;
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n");
      const kept: string[] = [];

      for (const line of lines) {
        if (line.startsWith("- ")) {
          const lineLower = line.toLowerCase();
          if (lineLower.includes(queryLower)) {
            removed++;
            continue;
          }
        }
        kept.push(line);
      }

      if (removed > 0) {
        await fs.writeFile(filePath, kept.join("\n"), "utf8");
      }
    } finally {
      release();
    }

    // Re-index if we removed anything
    if (removed > 0) {
      const reconciler = new Reconciler({
        dataRoot: this.dataRoot,
        projectPath: this.projectPath,
        index: this.index,
      });
      await reconciler.sync();
    }

    return { removed };
  }

  /**
   * Parse a docId into its components.
   * Format: `${filePath}#${heading}` or just `${filePath}`
   */
  private parseDocId(
    docId: string,
  ): { filePath: string; scope: Scope; heading: string } | null {
    const hashIdx = docId.indexOf("#");
    let filePath: string;
    let heading: string;
    if (hashIdx !== -1) {
      filePath = docId.slice(0, hashIdx);
      heading = docId.slice(hashIdx + 1);
    } else {
      filePath = docId;
      heading = "";
    }

    // Determine scope from path
    let scope: Scope;
    const normalizedPath = filePath.replace(/\\/g, "/");
    if (normalizedPath.includes("/global/")) {
      scope = "global";
    } else if (normalizedPath.includes("/sessions/")) {
      scope = "session";
    } else {
      scope = "project";
    }

    return { filePath, scope, heading };
  }

  /**
   * Extract a snippet around the first matched term in the source file.
   */
  private async extractSnippet(
    filePath: string,
    heading: string,
    matchedTerms: string[],
  ): Promise<string> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      return "";
    }

    // If we have a heading, extract just that section
    if (heading) {
      const headingMarker = `## ${heading}`;
      const headingIdx = content.indexOf(headingMarker);
      if (headingIdx !== -1) {
        const afterHeading = content.indexOf("\n", headingIdx + headingMarker.length);
        const nextHeading = content.indexOf("\n## ", headingIdx + headingMarker.length);
        const start = afterHeading !== -1 ? afterHeading + 1 : headingIdx + headingMarker.length;
        const end = nextHeading !== -1 ? nextHeading : content.length;
        content = content.slice(start, end).trim();
      }
    }

    // Find position of first matched term
    let bestPos = -1;
    for (const term of matchedTerms) {
      const pos = content.toLowerCase().indexOf(term.toLowerCase());
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
      }
    }

    if (bestPos === -1) {
      // No direct match found — return beginning of content
      return content.slice(0, 200).trim();
    }

    // Extract 100 chars before + after
    const start = Math.max(0, bestPos - 100);
    const end = Math.min(content.length, bestPos + 100);
    let snippet = content.slice(start, end).trim();

    // Add ellipsis markers
    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";

    return snippet;
  }
}
