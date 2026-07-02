/**
 * Cross-hook in-memory state for opencode-deep-memory plugin.
 */

import path from "node:path";
import fs from "node:fs";

export interface AgentSessionMap {
  /** Map<sessionID, agent> */
  get(sessionID: string): string | undefined;
  set(sessionID: string, agent: string): void;
  delete(sessionID: string): void;
  has(sessionID: string): boolean;
}

export interface PendingResumeInfo {
  budgetTokens: number;
  projectHash: string;
  setAt: number;
}

export interface PendingResumeMap {
  /** Map<sessionID, PendingResumeInfo> */
  get(sessionID: string): PendingResumeInfo | undefined;
  set(sessionID: string, info: PendingResumeInfo): void;
  delete(sessionID: string): void;
  has(sessionID: string): boolean;
}

/** Compression stats from messages.transform. */
export interface CompressionStats {
  reasoning_cleared: number;
  metadata_stripped: number;
  system_neutralized: number;
  tool_errors_truncated: number;
  thinking_stripped: number;
}

/** Injection stats from system.transform. */
export interface InjectionStats {
  stableSize: number;
  volatileSize: number;
  tier: string;
  mode: string;
  /** Number of search results allocated into volatile. */
  searchEntries: number;
  /** Number of repo-map symbols injected. */
  repoMapEntries: number;
  /** Whether a checkpoint was injected. */
  hasCheckpoint: boolean;
}

/** Aggregated notification data from one LLM turn. */
export interface PendingNotify {
  compression?: CompressionStats;
  injection?: InjectionStats;
  /** Total messages in the session at transform time. */
  messageCount?: number;
  /** Number of messages in the protected head zone. */
  protectedHead?: number;
  /** Number of messages in the protected tail zone. */
  protectedTail?: number;
  /** Deep compression stats. */
  deepCompression?: DeepCompressionStats;
  /** Timestamp of first stat write (for cooldown). */
  setAt: number;
}

/** Stats from the deep compression pipeline. */
export interface DeepCompressionStats {
  toolDedup: number;
  errorPurge: number;
  toolOutputCompressed: number;
  jsonCrushed: number;
  assistantCompressed: number;
  ccrStored: number;
  nudgeInjected: boolean;
  pressureLevel: "low" | "medium" | "high";
  estimatedTokens: number;
}

/** CCR (Compress-Cache-Retrieve) entry. */
export interface CCRCacheEntry {
  hash: string;
  original: string;
  compressed: string;
  createdAt: number;
  toolName?: string;
  callID?: string;
}

export class PluginState {
  private _agents = new Map<string, string>();
  private _models = new Map<string, { providerID: string; modelID: string }>();
  private _projectModel: { providerID: string; modelID: string } | undefined;
  private _fallbackModel: { providerID: string; modelID: string } | undefined;
  private _pendingResumes = new Map<string, PendingResumeInfo>();
  private _lastUserText = new Map<string, string>();
  private _pendingNotify: PendingNotify | null = null;
  private _toolSignatures = new Map<string, string>();
  private _ccrCache = new Map<string, CCRCacheEntry>();
  private _lastInputTokens = 0;
  private _lastNudgeMessageCount = new Map<string, number>();
  private _lastMemoryNudgeMessageCount = new Map<string, number>();
  private _lastCCRCleanup = 0;
  private _modelContextWindow = 0;
  private _recentEdits = new Set<string>();
  private _memoryCache: { content: string; mtime: number } | undefined;
  private _pendingContentAwareCompression: { keepRecent: number; summary: string; requestedAt: number } | undefined;
  private _greetedSessions = new Set<string>();
  private _nudgedSessions = new Map<string, Set<string>>();
  private _pendingPostCompactNudges = new Set<string>();
  private _pendingConsolidation: Record<string, { subSessionID: string; memMtime: number }> = {};

  agentOf(sessionID: string): string | undefined {
    return this._agents.get(sessionID);
  }

  recordAgent(sessionID: string, agent: string): void {
    this._agents.set(sessionID, agent);
  }

  forgetAgent(sessionID: string): void {
    this._agents.delete(sessionID);
    this._models.delete(sessionID);
    this._lastUserText.delete(sessionID);
    this._lastNudgeMessageCount.delete(sessionID);
    this._lastMemoryNudgeMessageCount.delete(sessionID);
  }

  recordModel(sessionID: string, model: { providerID: string; modelID: string }): void {
    this._models.set(sessionID, model);
    this._projectModel = model;
  }

  modelOf(sessionID: string): { providerID: string; modelID: string } | undefined {
    return this._models.get(sessionID);
  }

  projectModel(): { providerID: string; modelID: string } | undefined {
    return this._projectModel;
  }

  recordFallbackModel(model: { providerID: string; modelID: string }): void {
    this._fallbackModel = model;
  }

  bestModel(): { providerID: string; modelID: string } | undefined {
    return this._projectModel ?? this._fallbackModel;
  }

  /**
   * Set a pending resume flag for a sessionID.
   * Called by session.created event handler when MEMORY.md exists.
   */
  setPendingResume(
    sessionID: string,
    info: { budgetTokens: number; projectHash: string },
  ): boolean {
    const existing = this._pendingResumes.get(sessionID);
    if (existing && Date.now() - existing.setAt < 5000) return false;
    this._pendingResumes.set(sessionID, {
      budgetTokens: info.budgetTokens,
      projectHash: info.projectHash,
      setAt: Date.now(),
    });
    return true;
  }

  /**
   * Consume (read + delete) the pending resume flag.
   * Returns the info if the flag was set, or undefined if not.
   * Idempotent: second call returns undefined.
   */
  consumePendingResume(
    sessionID: string,
  ): { budgetTokens: number; projectHash: string } | undefined {
    const entry = this._pendingResumes.get(sessionID);
    if (!entry) return undefined;
    this._pendingResumes.delete(sessionID);
    return { budgetTokens: entry.budgetTokens, projectHash: entry.projectHash };
  }

  /** Check whether a pending resume flag exists for a sessionID. */
  hasPendingResume(sessionID: string): boolean {
    return this._pendingResumes.has(sessionID);
  }

  recordLastUserText(sessionID: string, text: string): void {
    this._lastUserText.set(sessionID, text.slice(0, 500));
  }

  consumeLastUserText(sessionID: string): string | undefined {
    const text = this._lastUserText.get(sessionID);
    this._lastUserText.delete(sessionID);
    return text;
  }

  /**
   * Merge stats into the pending notification.
   * Called from messages.transform (compression) and system.transform (injection).
   * Creates a new PendingNotify on first call per turn.
   */
  mergeNotify(patch: Omit<PendingNotify, "setAt">): void {
    if (!this._pendingNotify) {
      this._pendingNotify = { ...patch, setAt: Date.now() };
      return;
    }
    if (patch.compression) {
      this._pendingNotify.compression = patch.compression;
    }
    if (patch.injection) {
      this._pendingNotify.injection = patch.injection;
    }
    if (patch.messageCount !== undefined) {
      this._pendingNotify.messageCount = patch.messageCount;
    }
    if (patch.protectedHead !== undefined) {
      this._pendingNotify.protectedHead = patch.protectedHead;
    }
    if (patch.protectedTail !== undefined) {
      this._pendingNotify.protectedTail = patch.protectedTail;
    }
  }

  consumePendingNotify(): PendingNotify | null {
    const n = this._pendingNotify;
    this._pendingNotify = null;
    return n;
  }

  recordToolSignature(callID: string, signature: string): void {
    this._toolSignatures.set(callID, signature);
  }

  isDuplicateTool(signature: string): boolean {
    for (const existing of this._toolSignatures.values()) {
      if (existing === signature) return true;
    }
    return false;
  }

  getToolSignature(callID: string): string | undefined {
    return this._toolSignatures.get(callID);
  }

  ccStore(hash: string, entry: CCRCacheEntry): void {
    const now = Date.now();
    // Lazy eviction: sweep only every 30s to amortize cost
    if (now - this._lastCCRCleanup > 30000) {
      for (const [k, v] of this._ccrCache) {
        if (now - v.createdAt > 300000) this._ccrCache.delete(k);
      }
      // LRU: if still over cap, delete oldest N (Map iteration order = insertion order)
      if (this._ccrCache.size > 200) {
        const excess = this._ccrCache.size - 150;
        const oldest = [...this._ccrCache.keys()].slice(0, excess);
        for (const k of oldest) this._ccrCache.delete(k);
      }
      this._lastCCRCleanup = now;
    }
    this._ccrCache.set(hash, entry);
  }

  ccrGet(hash: string): CCRCacheEntry | undefined {
    return this._ccrCache.get(hash);
  }

  recordInputTokens(tokens: number): void {
    this._lastInputTokens = tokens;
  }

  lastInputTokens(): number {
    return this._lastInputTokens;
  }

  recordNudge(sessionID: string, messageCount: number): void {
    this._lastNudgeMessageCount.set(sessionID, messageCount);
  }

  messagesSinceLastNudge(sessionID: string, currentMessageCount: number): number {
    const last = this._lastNudgeMessageCount.get(sessionID);
    return last != null ? currentMessageCount - last : Number.POSITIVE_INFINITY;
  }

  recordMemoryNudge(sessionID: string, messageCount: number): void {
    this._lastMemoryNudgeMessageCount.set(sessionID, messageCount);
  }

  messagesSinceLastMemoryNudge(sessionID: string, currentMessageCount: number): number {
    const last = this._lastMemoryNudgeMessageCount.get(sessionID);
    return last != null ? currentMessageCount - last : Number.POSITIVE_INFINITY;
  }

  getModelContextWindow(): number {
    return this._modelContextWindow;
  }

  trackEdit(filePath: string): void {
    if (filePath) this._recentEdits.add(filePath);
  }

  getRecentEdits(): string[] {
    return Array.from(this._recentEdits);
  }

  /** D5: mtime-based MEMORY.md cache for byte-stable system prompts. */
  setMemoryCache(content: string, mtime: number): void {
    this._memoryCache = { content, mtime };
  }

  getMemoryCache(): { content: string; mtime: number } | undefined {
    return this._memoryCache;
  }

  isMemoryCacheFresh(currentMtime: number): boolean {
    return this._memoryCache?.mtime === currentMtime;
  }

  clearMemoryCache(): void {
    this._memoryCache = undefined;
  }

  /** A: Session-start greeting — only inject memory whisper once per session. */
  hasGreetedSession(sessionID: string): boolean {
    return this._greetedSessions.has(sessionID);
  }

  /** P1: schedule content-aware compression (triggered by context_compress tool). */
  requestContentAwareCompression(req: { keepRecent: number; summary: string }): void {
    this._pendingContentAwareCompression = { ...req, requestedAt: Date.now() };
  }

  consumeContentAwareCompression(): { keepRecent: number; summary: string } | undefined {
    if (!this._pendingContentAwareCompression) return undefined;
    const req = this._pendingContentAwareCompression;
    this._pendingContentAwareCompression = undefined;
    return { keepRecent: req.keepRecent, summary: req.summary };
  }

  markGreetedSession(sessionID: string): void {
    this._greetedSessions.add(sessionID);
  }

  /** P3: threshold nudge fires once per session; emergency always fires. */
  tryNudge(type: "threshold" | "emergency", sessionID: string): boolean {
    if (type === "emergency") return true;
    let set = this._nudgedSessions.get(sessionID);
    if (!set) { set = new Set(); this._nudgedSessions.set(sessionID, set); }
    if (set.has(type)) return false;
    set.add(type);
    return true;
  }

  setPendingPostCompactNudge(sessionID: string): void {
    this._pendingPostCompactNudges.add(sessionID);
  }

  consumePendingPostCompactNudge(sessionID: string): boolean {
    const had = this._pendingPostCompactNudges.has(sessionID);
    this._pendingPostCompactNudges.delete(sessionID);
    return had;
  }

  resetNudges(sessionID: string): void {
    this._nudgedSessions.delete(sessionID);
  }

  /** P0: set pending consolidation sub-session. */
  setPendingConsolidation(sessionID: string, info: { subSessionID: string; memMtime: number }): void {
    this._pendingConsolidation[sessionID] = info;
  }

  /** P0: consume pending consolidation (destructive read). */
  consumePendingConsolidation(sessionID: string): { subSessionID: string; memMtime: number } | undefined {
    const info = this._pendingConsolidation[sessionID];
    delete this._pendingConsolidation[sessionID];
    return info;
  }

  /** P0 (Grill #5): persist pending consolidation to survive restarts. */
  persistPendingConsolidation(projectDir: string): void {
    const keys = Object.keys(this._pendingConsolidation);
    if (keys.length === 0) {
      const filePath = path.join(projectDir, ".pending-consolidation.json");
      try { fs.unlinkSync(filePath); } catch {}
      return;
    }
    const sid = keys[0];
    const info = this._pendingConsolidation[sid];
    const filePath = path.join(projectDir, ".pending-consolidation.json");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ sessionID: sid, subSessionID: info.subSessionID, memMtime: info.memMtime }),
      "utf8",
    );
  }

  /** P0 (Grill #5): restore pending consolidation from file. Returns true if restored. */
  restorePendingConsolidation(projectDir: string): boolean {
    const filePath = path.join(projectDir, ".pending-consolidation.json");
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as { sessionID: string; subSessionID: string; memMtime: number };
      if (parsed.sessionID && parsed.subSessionID) {
        this._pendingConsolidation[parsed.sessionID] = { subSessionID: parsed.subSessionID, memMtime: parsed.memMtime };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

/** Factory function for creating a fresh PluginState instance. */
export function createPluginState(): PluginState {
  return new PluginState();
}
