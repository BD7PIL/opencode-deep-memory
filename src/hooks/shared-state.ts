/**
 * Cross-hook in-memory state for opencode-deep-memory plugin.
 *
 * Owns:
 *   - sessionID → agent mapping (populated by chat.params, consumed by system.transform)
 *   - pendingResume flags (set by session.created event, consumed by system.transform)
 */

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
  /** Timestamp of first stat write (for cooldown). */
  setAt: number;
}

export class PluginState {
  private _agents = new Map<string, string>();
  private _models = new Map<string, { providerID: string; modelID: string }>();
  private _projectModel: { providerID: string; modelID: string } | undefined;
  private _fallbackModel: { providerID: string; modelID: string } | undefined;
  private _pendingResumes = new Map<string, PendingResumeInfo>();
  private _pendingEnrichments = new Set<string>();
  private _lastUserText = new Map<string, string>();
  private _pendingNotify: PendingNotify | null = null;

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

  /**
   * Mark a sessionID as having a pending enrichment.
   * Called by the compacting hook after writing checkpoint.md.
   */
  setPendingEnrichment(sessionID: string): void {
    this._pendingEnrichments.add(sessionID);
  }

  /**
   * Consume (read + delete) the pending enrichment flag.
   * Returns true if the flag was set, false if not.
   * Idempotent: second call returns false.
   */
  consumePendingEnrichment(sessionID: string): boolean {
    const had = this._pendingEnrichments.has(sessionID);
    this._pendingEnrichments.delete(sessionID);
    return had;
  }

  /** Check whether a pending enrichment flag exists for a sessionID. */
  hasPendingEnrichment(sessionID: string): boolean {
    return this._pendingEnrichments.has(sessionID);
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
}

/** Factory function for creating a fresh PluginState instance. */
export function createPluginState(): PluginState {
  return new PluginState();
}
