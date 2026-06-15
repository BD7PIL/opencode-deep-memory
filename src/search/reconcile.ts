/**
 * Markdown ↔ BM25 Index synchronization.
 *
 * Walks the storage tree, diffs file mtimes against stored state,
 * and updates the BM25 index incrementally.
 *
 * Each markdown file is split by `##` headings; each heading section
 * becomes a separate document with docId = `${filePath}#${headingText}`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { acquireLock } from "../shared/lock.js";
import {
  indexStateFilePath,
  projectMemoryDir,
  globalMemoryDir,
} from "../shared/paths.js";
import type { Scope } from "../shared/paths.js";
import { tokenize } from "./tokenizer.js";
import type { BM25Index } from "./bm25.js";

/** File metadata collected during enumeration. */
export interface FileEntry {
  path: string;
  scope: Scope;
  mtime: number;
}

/** Index state: map of filePath → mtime. */
export type IndexState = Record<string, number>;

/** Result of a sync operation. */
export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

/** Result of a full rebuild. */
export interface RebuildResult {
  total: number;
}

/** Options for constructing a Reconciler. */
export interface ReconcilerOptions {
  dataRoot: string;
  projectPath: string;
  index: BM25Index;
}

/**
 * Split markdown content into heading-delimited sections.
 * Each section is [heading, body]. The first section may have heading "".
 */
function splitByHeadings(content: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Flush previous section
      if (currentHeading !== "" || currentBody.length > 0) {
        sections.push({
          heading: currentHeading,
          body: currentBody.join("\n").trim(),
        });
      }
      currentHeading = line.slice(3).trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  // Flush last section
  if (currentHeading !== "" || currentBody.length > 0) {
    sections.push({
      heading: currentHeading,
      body: currentBody.join("\n").trim(),
    });
  }
  return sections;
}

/**
 * Reconciler: walks markdown files, diffs against stored mtimes, updates BM25 index.
 */
export class Reconciler {
  private readonly projectPath: string;
  private readonly index: BM25Index;
  private indexState: IndexState = {};

  constructor(opts: ReconcilerOptions) {
    this.projectPath = opts.projectPath;
    this.index = opts.index;
  }

  /**
   * Incremental sync: detect changed/new/removed files and update the index.
   */
  async sync(): Promise<SyncResult> {
    await this.loadIndexState();

    const files = await this.enumerateAllMarkdown();
    const currentPaths = new Set(files.map((f) => f.path));
    const statePaths = new Set(Object.keys(this.indexState));

    let added = 0;
    let modified = 0;
    let removed = 0;

    // Process new and modified files
    for (const file of files) {
      const storedMtime = this.indexState[file.path];
      if (storedMtime === undefined) {
        await this.indexFile(file);
        added++;
      } else if (storedMtime !== file.mtime) {
        await this.indexFile(file);
        modified++;
      }
    }

    // Remove deleted files
    for (const stalePath of statePaths) {
      if (!currentPaths.has(stalePath)) {
        this.removeFileFromIndex(stalePath);
        removed++;
      }
    }

    await this.saveIndexState();
    return { added, modified, removed };
  }

  /**
   * Full rebuild: clear the index and re-index everything from scratch.
   */
  async rebuild(): Promise<RebuildResult> {
    // Clear existing index state
    this.indexState = {};

    const files = await this.enumerateAllMarkdown();
    for (const file of files) {
      await this.indexFile(file);
    }

    await this.saveIndexState();
    return { total: files.length };
  }

  /**
   * Enumerate all markdown files across global, project, and session scopes.
   */
  async enumerateAllMarkdown(): Promise<FileEntry[]> {
    const results: FileEntry[] = [];
    for (const scope of ["global", "project", "session"] as Scope[]) {
      const files = await this.enumerateMarkdown(scope);
      results.push(...files);
    }
    return results;
  }

  /**
   * Enumerate markdown files for a specific scope.
   */
  async enumerateMarkdown(scope: Scope): Promise<FileEntry[]> {
    const results: FileEntry[] = [];

    let dir: string;
    switch (scope) {
      case "global":
        dir = globalMemoryDir();
        break;
      case "project":
        dir = projectMemoryDir(this.projectPath);
        break;
      case "session": {
        const sessionsDir = path.join(projectMemoryDir(this.projectPath), "sessions");
        if (!existsSync(sessionsDir)) return [];
        const sessionDirs = await fs.readdir(sessionsDir);
        for (const sid of sessionDirs) {
          const sessionDir = path.join(sessionsDir, sid);
          const stat = await fs.stat(sessionDir);
          if (!stat.isDirectory()) continue;
          const files = await this.walkMarkdown(sessionDir, scope);
          results.push(...files);
        }
        return results;
      }
    }

    if (!existsSync(dir)) return [];
    return this.walkMarkdown(dir, scope);
  }

  /**
   * Walk a directory and collect all .md files with their mtimes.
   */
  private async walkMarkdown(
    dir: string,
    scope: Scope,
  ): Promise<FileEntry[]> {
    const results: FileEntry[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && entry.endsWith(".md")) {
          results.push({ path: fullPath, scope, mtime: stat.mtimeMs });
        }
      } catch {
        // Skip files we can't stat
      }
    }
    return results;
  }

  /**
   * Index a single file: read content, split by headings, tokenize, add to BM25.
   */
  private async indexFile(file: FileEntry): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(file.path, "utf8");
    } catch {
      // Can't read — skip
      return;
    }

    // Remove all existing docs for this file
    this.removeFileFromIndex(file.path);

    const sections = splitByHeadings(content);
    for (const section of sections) {
      const docId = section.heading
        ? `${file.path}#${section.heading}`
        : file.path;
      const textToTokenize = section.heading
        ? `${section.heading} ${section.body}`
        : section.body;
      const tokens = tokenize(textToTokenize);
      if (tokens.length > 0) {
        let timestamp: Date | undefined;
        const tsMatch = section.body.match(/\[(\d{4}-\d{2}-\d{2})\]/);
        if (tsMatch) {
          const parsed = new Date(tsMatch[1] + "T00:00:00Z");
          if (!isNaN(parsed.getTime())) timestamp = parsed;
        }
        this.index.addDocument(docId, tokens, timestamp);
      }
    }

    this.indexState[file.path] = file.mtime;
  }

  /**
   * Remove all documents belonging to a file from the index.
   */
  private removeFileFromIndex(filePath: string): void {
    const prefix = filePath + "#";
    // We need to iterate the index's documents to find matching docIds.
    // Since BM25Index doesn't expose iteration, we use toJSON() to get docIds.
    const snapshot = this.index.toJSON();
    for (const doc of snapshot.documents) {
      if (doc.docId === filePath || doc.docId.startsWith(prefix)) {
        this.index.removeDocument(doc.docId);
      }
    }
    delete this.indexState[filePath];
  }

  /**
   * Load index state from disk.
   */
  private async loadIndexState(): Promise<void> {
    const statePath = this.getStatePath();
    if (!existsSync(statePath)) {
      this.indexState = {};
      return;
    }
    try {
      const raw = readFileSync(statePath, "utf8");
      this.indexState = JSON.parse(raw) as IndexState;
    } catch {
      this.indexState = {};
    }
  }

  /**
   * Save index state to disk with file locking.
   */
  private async saveIndexState(): Promise<void> {
    const statePath = this.getStatePath();
    const dir = path.dirname(statePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    const release = await acquireLock(statePath);
    try {
      await fs.writeFile(
        statePath,
        JSON.stringify(this.indexState, null, 2),
        "utf8",
      );
    } finally {
      release();
    }
  }

  /**
   * Path to the index state file.
   */
  private getStatePath(): string {
    return indexStateFilePath(this.projectPath);
  }
}
