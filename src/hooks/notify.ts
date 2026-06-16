import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { PendingNotify, CompressionStats, InjectionStats } from "./shared-state.js";
import type { Logger } from "../shared/log.js";

type Client = ReturnType<typeof createOpencodeClient>;

const COOLDOWN_MS = 5000;

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function totalStripped(c: CompressionStats): number {
  return c.reasoning_cleared + c.metadata_stripped + c.system_neutralized
    + c.tool_errors_truncated + c.thinking_stripped;
}

function renderProgressBar(total: number, processed: number, width = 40): string {
  if (total === 0) return `│${"░".repeat(width)}│`;
  const filled = Math.round((processed / total) * width);
  const bar = "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
  return `│${bar}│`;
}

function formatCompressionBlock(c: CompressionStats, msgCount?: number, head?: number, tail?: number): string {
  const lines: string[] = [];

  if (msgCount && msgCount > 0) {
    const protectedZones = (head ?? 0) + (tail ?? 0);
    const scannable = Math.max(0, msgCount - protectedZones);
    const affected = Math.min(scannable, totalStripped(c));
    lines.push(renderProgressBar(scannable, affected));
  }

  const parts: string[] = [];
  if (c.reasoning_cleared > 0) parts.push(`reasoning -${formatK(c.reasoning_cleared)}`);
  if (c.metadata_stripped > 0) parts.push(`metadata -${formatK(c.metadata_stripped)}`);
  if (c.tool_errors_truncated > 0) parts.push(`tool_err -${formatK(c.tool_errors_truncated)}`);
  if (c.thinking_stripped > 0) parts.push(`thinking -${formatK(c.thinking_stripped)}`);
  if (c.system_neutralized > 0) parts.push(`sys_inject -${formatK(c.system_neutralized)}`);
  if (parts.length > 0) lines.push(`  ${parts.join(" | ")}`);

  return lines.join("\n");
}

function formatInjectionBlock(i: InjectionStats): string {
  const cacheStatus = i.stableSize > 0 ? "✓" : "—";
  const lines = [
    `  m[0] stable ${formatK(i.stableSize)}B ${cacheStatus}  m[1] volatile ${formatK(i.volatileSize)}B`,
    `  tier=${i.tier} | mode=${i.mode}`,
  ];
  const details: string[] = [];
  if (i.repoMapEntries > 0) details.push(`repo-map: ${i.repoMapEntries} symbols`);
  if (i.searchEntries > 0) details.push(`memory: ${i.searchEntries} entries`);
  if (i.hasCheckpoint) details.push(`checkpoint ✓`);
  if (details.length > 0) lines.push(`  ${details.join(" | ")}`);
  return lines.join("\n");
}

function chooseLevel(n: PendingNotify): "minimal" | "detailed" | "extended" {
  if (!n.compression && n.injection) return "minimal";
  if (!n.compression) return "minimal";
  const hasRichContext = n.injection && (
    n.injection.repoMapEntries > 0 || n.injection.searchEntries > 0 || n.injection.hasCheckpoint
  );
  if (hasRichContext && n.messageCount && n.messageCount > 20) return "extended";
  return "detailed";
}

function formatNotify(n: PendingNotify): string {
  const level = chooseLevel(n);

  if (level === "minimal") {
    const parts: string[] = ["▣ deep-memory"];
    if (n.compression) parts.push(`-${formatK(totalStripped(n.compression))} stripped`);
    if (n.injection) parts.push(`+${formatK(n.injection.stableSize + n.injection.volatileSize)}B injected`);
    return parts.join(" | ");
  }

  if (level === "extended") {
    const sections: string[] = [];
    if (n.compression) {
      sections.push("─ Compression ─────────────────────────────");
      if (n.messageCount) {
        const head = n.protectedHead ?? 0;
        const tail = n.protectedTail ?? 0;
        sections.push(`  messages: ${n.messageCount} (protected: head=${head} tail=${tail})`);
      }
      sections.push(formatCompressionBlock(n.compression, n.messageCount, n.protectedHead, n.protectedTail));
    }
    if (n.injection) {
      sections.push("─ Injection ───────────────────────────────");
      sections.push(formatInjectionBlock(n.injection));
      const budgetUsed = n.injection.stableSize + n.injection.volatileSize;
      const maxBudget = 4000;
      const pct = Math.round((budgetUsed / maxBudget) * 100);
      sections.push(`  budget: ${formatK(budgetUsed)}B / ${formatK(maxBudget)}B (${pct}%)`);
    }
    return ["▣ deep-memory", ...sections].join("\n");
  }

  // detailed (default)
  const sections: string[] = [];
  if (n.compression) {
    sections.push("─ Compression ─────────────────────────────");
    sections.push(formatCompressionBlock(n.compression, n.messageCount, n.protectedHead, n.protectedTail));
  }
  if (n.injection) {
    sections.push("─ Injection ───────────────────────────────");
    sections.push(formatInjectionBlock(n.injection));
  }
  return ["▣ deep-memory", ...sections].join("\n");
}

export function createNotifyHandler(
  client: Client,
  logger?: Logger,
): (sessionID: string, notify: PendingNotify) => Promise<void> {
  let lastNotifyAt = 0;

  return async (sessionID: string, notify: PendingNotify) => {
    const hasCompression = notify.compression && totalStripped(notify.compression) > 0;
    const hasInjection = !!notify.injection;
    if (!hasCompression && !hasInjection) return;

    if (notify.setAt - lastNotifyAt < COOLDOWN_MS) return;
    lastNotifyAt = Date.now();

    const message = formatNotify(notify);
    const title = hasCompression ? "deep-memory | compressed" : "deep-memory | injected";

    try {
      await client.tui.showToast({
        body: {
          title,
          message,
          variant: "info",
          duration: 5000,
        },
      });
      logger?.debug("notify: sent", { level: chooseLevel(notify) });
    } catch (err) {
      logger?.debug("notify: failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
