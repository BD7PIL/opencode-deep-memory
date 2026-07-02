# V5 优化计划 — 记忆整理 + 内容感知压缩

> **基于**: 6 轮调研（7 生产 agent + 30+ 记忆系统 + When2Tool + DCP nudge + V4 benchmark + omo subagent）
> **前提**: 不依赖 omo；不注入 message ID；nudge 保留但重新设计

---

## 1. 现状诊断

### V4 的两个结构性缺口

| 缺口 | 证据 | 影响 |
|---|---|---|
| 记忆质量只靠 SimHash 去重，无 LLM 提炼 | Mem0/Letta/A-Mem 都有 LLM 驱动的 ADD/UPDATE/DELETE；V4 只有确定性 dedup | MEMORY.md 会积累语义重复但字面不同的条目 |
| context_compress 无内容感知 | benchmark: 75% 候选消息因 keep-pattern 太宽松而原样返回；compressAssistantText 实际只压缩 19.3% 的 assistant bytes | 压缩效果粗糙，token 节省不足 |

### nudge 的证据链（不可移除）

| 证据 | 来源 |
|---|---|
| DCP v3.0.1-v3.0.4 nudge prompt 清空 → 压缩完全停止 | [Issue #449](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/issues/449) |
| LLM 知道何时用工具 (AUROC 0.89) 但生成时不行动；prompt engineering 无法修复 | [When2Tool, arxiv 2605.09252](https://arxiv.org/abs/2605.09252) |
| system prompt 中指令的注意力前 10 轮下降最陡 | [When Attention Closes, arxiv 2605.12922](https://arxiv.org/html/2605.12922) |
| Claude Code / Cline / Aider / OpenAI GPT-4.1 全部使用 nudge | 各源码 + OpenAI official guidance |
| omo 有 6 种独立的 nudge 机制 | omo dist/index.js 源码分析 |

**结论**: nudge 保留，但重新设计为事件驱动 + cooldown，不是 DCP 式的每消息注入。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     OpenCode Session Lifecycle                       │
│                                                                      │
│  chat.params ──> system.transform ──> messages.transform ──> LLM    │
│                       │                      │                       │
│                  ┌─────┴────┐          ┌──────┴──────┐               │
│                  │ V4 Layer │          │ P1 content- │               │
│                  │ 3/4 (保持)│         │ aware       │               │
│                  │ + P3 nudge│          │ compress    │               │
│                  └──────────┘          └─────────────┘               │
│                                                                      │
│  session.compacting ──> P0 subagent consolidation ──> 写回 MEMORY.md │
│                                                                      │
│  tool.execute.after ──> P2 keep-pattern tightening (内联改动)       │
└─────────────────────────────────────────────────────────────────────┘
```

### 与 V4 的关系

V5 **不重写** V4 的 Layer 1-5。它增量地添加三个模块：

| 模块 | 改动的 V4 层 | 改动方式 |
|---|---|---|
| P0: Subagent 记忆整理 | Layer 5（consolidation） | 新增 LLM 整理路径，保留 SimHash 去重 |
| P1: Content-aware compress | Layer 6（compress tool） | 重写 context_compress + 新增 content-classifier |
| P2: keep-pattern 收紧 | Layer 6（single-pass） | 修改 compressAssistantText 参数 |
| P3: Nudge 机制 | 新增 | event-driven, cooldown, 非 per-message |

---

## 3. P0: Subagent 记忆整理

### 3.1 触发

`experimental.session.compacting` hook。这是同步 hook，host 在 await。

### 3.2 执行

```typescript
// compacting.ts，在 SimHash dedup 之后

const memPath = memoryFilePath("project", "memory", projectPath);
if (existsSync(memPath)) {
  const content = await readFile(memPath, "utf8");
  
  // Step A: V4 SimHash dedup (保留)
  const deduped = consolidateMemory(content);
  
  // Step B: V5 LLM 整理 (新增)
  // 检查是否有 pending 整理任务
  const pendingConsolidation = state.consumePendingConsolidation(sessionID);
  if (pendingConsolidation) {
    // 子 session 已完成，提取结果
    const consolidated = await extractSubagentResult(client, pendingConsolidation.subSessionID);
    if (consolidated) {
      await backupAndWrite(memPath, consolidated);
    }
  }
  
  // 如果没有 pending 任务且 MEMORY.md 较大，启动新的子 session
  if (!pendingConsolidation && deduped.split("\n").length > 50) {
    const subSession = await client.session.create({
      body: { parentID: sessionID, title: `Memory Consolidation ${new Date().toISOString().slice(0,10)}` },
      query: { directory: projectPath },
    });
    const subID = subSession.data?.id;
    if (subID) {
      await client.session.promptAsync({
        path: { id: subID },
        body: { body: buildConsolidationPrompt(deduped) },
      });
      state.setPendingConsolidation(sessionID, { subSessionID: subID, createdAt: Date.now() });
    }
  }
  
  // 写回 SimHash dedup 结果（即使 LLM 整理未完成，dedup 结果先生效）
  if (deduped !== content) {
    const release = await acquireLock(memPath);
    try { await writeFile(memPath, deduped, "utf8"); } finally { release(); }
  }
}
```

### 3.3 整理 prompt（基于 Mem0 的 ADD/UPDATE/DELETE 模式）

```
You are a memory consolidation agent. Below is the current MEMORY.md content.
Your job is to refine it for quality — merge semantic duplicates, delete stale entries,
refine vague entries — and output the consolidated version.

Rules:
1. MERGE: Combine entries that say the same thing in different words into one clear entry.
2. DELETE: Remove entries that are clearly outdated or superseded by newer entries.
3. REFINE: Make vague entries more precise (add file paths, specific values, dates).
4. KEEP: Preserve entries that are unique and useful. Do NOT invent new information.
5. FORMAT: Keep the `## Heading` + `- entry [date]` format. Do NOT add new sections.
6. SIZE: Stay under 200 lines. If over, move overflow to a separate "## Archive" section.

Current MEMORY.md:
---
{{content}}
---

Output ONLY the consolidated MEMORY.md content, nothing else.
```

### 3.4 结果提取

```typescript
async function extractSubagentResult(
  client: PluginInput["client"],
  subSessionID: string,
): Promise<string | null> {
  try {
    const resp = await client.session.messages({
      path: { id: subSessionID },
      query: { limit: 1 },
    });
    const messages = resp.data ?? [];
    const last = messages[messages.length - 1];
    if (!last) return null;
    // 提取 assistant 最后一条消息的文本
    for (const part of last.parts) {
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        return p["text"];
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

### 3.5 安全保障

| 风险 | 缓解 |
|---|---|
| LLM 返回垃圾内容 | 写入前验证：必须包含 `## ` heading + `- ` entries；行数 ≤ 200 |
| 子 session 未完成 | 下次 compaction 再检查（pendingConsolidation 持久到下次） |
| 文件竞态 | acquireLock(memPath) 与 memory_store 共享锁 |
| 原文丢失 | 写入前备份到 MEMORY.bak.md |

### 3.6 失败模式

| 失败 | 行为 |
|---|---|
| client.session.create 失败 | log warn，跳过 LLM 整理，SimHash dedup 仍然生效 |
| promptAsync 失败 | 同上 |
| 子 session 超时（下次 compaction 时仍未完成） | 清除 pendingConsolidation，下次重新创建 |
| LLM 返回格式错误 | 不写入，log warn，保留 SimHash dedup 结果 |

---

## 4. P1: Content-aware context_compress

### 4.1 Tool 签名

```typescript
export function createContextCompressTool(state: PluginState, tracker?: RepoMapTracker) {
  return tool({
    description:
      "Compress older conversation context to reclaim token budget. " +
      "You provide a summary of what you want to remember from the old conversation; " +
      "the plugin handles the rest automatically.\n\n" +
      "WHEN to use: when the conversation is getting long and you're losing track.\n" +
      "WHAT to preserve in your summary: file paths, function signatures, key decisions, " +
      "error messages and their fixes, user-stated constraints.\n" +
      "WHAT to omit: verbose tool outputs, failed attempts, routine operations.",
    args: {
      summary: tool.schema
        .string()
        .describe("Your summary of the old conversation that you want preserved"),
      keep_recent: tool.schema
        .number()
        .default(8)
        .describe("Number of recent messages to protect (default 8)"),
    },
    async execute(args) {
      const keep = Math.max(2, Math.floor(args.keep_recent));
      state.requestContentAwareCompression({
        keepRecent: keep,
        summary: args.summary,
      });
      return {
        title: "Compression scheduled",
        output:
          `Will compress messages older than the last ${keep} on next turn. ` +
          `Your summary will replace the old content. ` +
          `Originals stored in CCR — call deep_expand("<hash>") to restore.`,
      };
    },
  });
}
```

### 4.2 压缩执行（messages-transform.ts）

```typescript
// 在 messages-transform.ts，现有 capture-cap 之后

const compressReq = state.consumeContentAwareCompression();
if (compressReq) {
  const cutoff = messages.length - compressReq.keepRecent;
  let compressed = 0;
  
  for (let i = 2; i < cutoff; i++) {
    const msg = messages[i];
    if (!msg?.parts?.length) continue;
    
    for (const part of msg.parts) {
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool") continue;
      const toolState = p["state"] as Record<string, unknown> | undefined;
      const toolName = p["tool"] as string | undefined;
      const output = typeof toolState?.["output"] === "string" ? toolState["output"] : "";
      if (!output || output.includes("deep_expand(")) continue;
      
      // Content-type-aware decision
      const decision = classifyForCompression(toolName, output, tracker);
      
      if (decision === "preserve") continue;
      
      if (decision === "transient") {
        // bash/grep/glob: head + tail, no summary needed
        const lines = output.split("\n");
        if (lines.length < 20) continue;
        const capped = lines.slice(0, 10).join("\n") +
          `\n[... ${lines.length - 20} lines compressed ...]\n` +
          lines.slice(-10).join("\n");
        const hash = ccrStore(state, output, capped, toolName);
        toolState!["output"] = ccrInjectMarker(capped, hash);
        compressed++;
      } else if (decision === "stale") {
        // read of a file that was edited since → mark outdated
        toolState!["output"] = "[OUTDATED — file was edited since this read. Use read to get current content.]";
        compressed++;
      }
      // "summarize" type: handled by the summary block below
    }
    
    // Replace assistant text in compressed zone with nothing 
    // (the summary block captures the essence)
    if (msg.info.role === "assistant" && i < cutoff - 2) {
      for (const part of msg.parts) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          const original = p["text"];
          if (original.length > 200 && !original.includes("deep_expand(")) {
            const hash = ccrStore(state, original, "[see summary block]", "assistant");
            (p as { text: string }).text = `[compressed — call deep_expand("${hash}") to restore]`;
            compressed++;
          }
        }
      }
    }
  }
  
  // Insert summary block at cutoff position
  if (compressed > 0) {
    const summaryBlock = {
      info: { role: "user" },
      parts: [{
        type: "text",
        text: `[compressed-block: 1-${cutoff}]\nThe following is the agent's summary of messages 1 through ${cutoff}:\n\n${compressReq.summary}\n[/compressed-block]`,
      }],
    };
    messages.splice(cutoff, 0, summaryBlock as never);
  }
}
```

### 4.3 Content-type classifier

```typescript
// src/compress/classifier.ts (新文件)

import type { RepoMapTracker } from "../repomap/tracker.js";

export type CompressionDecision = "transient" | "stale" | "summarize" | "preserve";

const TRANSIENT_TOOLS = new Set(["bash", "grep", "glob", "find", "search"]);
const PRESERVE_TOOLS = new Set(["edit", "write", "todowrite", "question", "memory_store", "memory_search", "memory_forget", "memory_expand", "deep_expand", "skill", "context_compress"]);

export function classifyForCompression(
  toolName: string | undefined,
  output: string,
  tracker?: RepoMapTracker,
): CompressionDecision {
  if (!toolName) return "summarize";
  if (PRESERVE_TOOLS.has(toolName)) return "preserve";
  
  // Stale read detection: read tool + file was edited since
  if (toolName === "read") {
    const filePath = extractPathFromReadOutput(output);
    if (filePath && tracker) {
      const recentEdits = tracker.getRecentlyRead(100);
      // If file appears in tracker with recent edit, mark stale
      // (simplified: if the read is old enough to be in compression zone,
      //  and the file was read again later, it's stale)
    }
    return "summarize"; // default for reads — let summary capture key content
  }
  
  if (TRANSIENT_TOOLS.has(toolName)) return "transient";
  
  return "summarize";
}
```

### 4.4 前台零干扰验证

| DCP 干扰 | V5 解决 |
|---|---|
| 每条消息注入 `[m0001]` 标签 | V5 不注入任何标签 |
| Per-turn nudge（每 5 轮） | V5 仅 threshold 触发 |
| Iteration nudge（每 15 次迭代） | V5 无 |
| Compress 哲学在 system prompt | V5 在 tool description（LLM 读一次） |
| 消息被截断后注入 nudge 解释 | V5 静默执行，tool result 确认 |

---

## 5. P2: keep-pattern 收紧

### 5.1 改动（single-pass.ts L65-69）

```typescript
// 当前（V4）：保留 headings + errors + bullets + numbered lists + paths
if (/^#{1,3}\s/.test(line) ||
    /error|fail|warning|critical|important/i.test(line) ||
    /^\s*[-*]\s/.test(line) ||        // ← 移除
    /^\s*\d+\.\s/.test(line) ||        // ← 移除
    /^\/[^\s:]+/.test(line)) {

// V5：只保留 headings + errors + paths
if (/^#{1,3}\s/.test(line) ||
    /error|fail|warning|critical|important/i.test(line) ||
    /^\/[^\s:]+/.test(line)) {
```

### 5.2 阈值调整

```typescript
// 当前
const ASSISTANT_COMPRESS_SAVINGS_RATIO = 0.6;
// V5
const ASSISTANT_COMPRESS_SAVINGS_RATIO = 0.7;
```

### 5.3 预期效果

benchmark 显示 75% 候选消息因 keep-pattern 太宽松而原样返回。移除 bullets/lists 后，保留行减少 ~40%，触发率从 25% 提升到 ~55%。

---

## 6. P3: Nudge 机制

### 6.1 设计原则

基于证据：DCP 的 per-message nudge 噪音大且有 obsessive loop 风险（[Issue #439](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/issues/439)）；但无 nudge 则工具不被调用（[Issue #449](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/issues/449)）。

V5 使用**事件驱动 + cooldown**，不是 per-message。

### 6.2 三种 nudge

| Nudge | 触发 | 注入位置 | Cooldown | 文本 |
|---|---|---|---|---|
| Threshold | context ≥ 70% | tool result 末尾 | 每 session 1 次 | `[context at 70% — consider using context_compress with a summary of old conversation]` |
| Emergency | context ≥ 90% | tool result 末尾 | 无（每次触发直到压缩） | `[context at 90% — use context_compress now with a summary to avoid compaction]` |
| PostCompact | compaction 后 | 下一条 tool result 末尾 | 每 compaction 1 次 | `[context was compacted — context_compress is available if you need to compress further]` |

### 6.3 实现

```typescript
// 在 messages-transform.ts，runCompressionPipeline 之后

const pressure = detectPressure(messages, state.getModelContextWindow());

if (pressure.ratio >= 0.7) {
  const nudged = state.tryNudge("threshold", sessionID ?? "default");
  if (nudged || pressure.ratio >= 0.9) {
    const text = pressure.ratio >= 0.9
      ? `\n[context at 90% — use context_compress now with a summary to avoid compaction]`
      : `\n[context at 70% — consider using context_compress with a summary of old conversation]`;
    injectIntoLastToolResult(messages, text);
  }
}

// PostCompact: 在 compacting hook 中设置标记
// 在 system.transform 或 messages.transform 中检查并注入
```

### 6.4 注入位置

`injectIntoLastToolResult` — 注入到最后一个 tool result 的 output 末尾，不是 user message，不是 system prompt。

依据：[When Attention Closes](https://arxiv.org/html/2605.12922) 显示 mid-conversation 注入比 system prompt 有更好的注意力持久性。

### 6.5 与 DCP 的对比

| 维度 | DCP | V5 |
|---|---|---|
| nudge 频率 | 每消息 | 仅 threshold/emergency/postcompact |
| nudge 位置 | system prompt + 消息标签 | tool result 末尾 |
| 注入文本量 | ~500 tokens/message | ~30 tokens/trigger |
| 噪音风险 | 高（obsessive loop, Issue #439） | 低（cooldown + event-driven） |
| 工具采用率 | 高（nudge 是承重的） | 预期高（threshold + emergency 覆盖关键时机） |

---

## 7. 实施计划

### Phase 1: P2（keep-pattern 收紧）— 最低风险，立即可做

| 改动 | 文件 | 行数 |
|---|---|---|
| 移除 bullets/lists 保留规则 | `src/compress/single-pass.ts` L67-68 | -2 行 |
| 调整 savings ratio 0.6→0.7 | `src/compress/single-pass.ts` L34 | 1 行 |

**验证**: benchmark 脚本跑前后对比，确认触发率从 25% → ~55%。

### Phase 2: P3（nudge 机制）— 中等风险

| 改动 | 文件 |
|---|---|
| 新增 nudge 状态管理 | `src/hooks/shared-state.ts` |
| 新增 injectIntoLastToolResult | `src/hooks/messages-transform.ts` |
| PostCompact 标记 | `src/hooks/compacting.ts` |

**验证**: 构造 70%+ context 场景，确认 nudge 触发且只触发一次。

### Phase 3: P1（content-aware compress）— 高收益

| 改动 | 文件 |
|---|---|
| 新增 classifier.ts | `src/compress/classifier.ts` |
| 重写 context_compress tool | `src/tools/context-compress.ts` |
| 新增 content-aware 压缩执行 | `src/hooks/messages-transform.ts` |
| 新增 summary block 注入 | 同上 |

**验证**: E2E 测试——构造长对话，调用 context_compress，验证 summary block 注入 + 原文存 CCR + deep_expand 可恢复。

### Phase 4: P0（subagent 记忆整理）— 最高复杂度

| 改动 | 文件 |
|---|---|
| 新增 pendingConsolidation 状态 | `src/hooks/shared-state.ts` |
| 新增 buildConsolidationPrompt | `src/extract/consolidate.ts` |
| 新增 extractSubagentResult | `src/hooks/compacting.ts` |
| 新增 backupAndWrite | `src/shared/index.ts` |
| 接入 compacting hook | `src/hooks/compacting.ts` |
| 接入 system.transform 检查 | `src/hooks/system-transform.ts` |

**验证**: 构造 50+ 条 MEMORY.md，触发 compaction，确认子 session 创建 → prompt 发送 → 结果提取 → MEMORY.md 更新。

---

## 8. 不做（证据否决）

| 方案 | 否决理由 | 证据 |
|---|---|---|
| LLMLingua perplexity 评分 | 需要 tokenizer 模型，0 deps 不可行 | microsoft/LLMLingua 依赖 onnxruntime |
| Aider 式递归摘要 | OpenCode 已有原生 compaction；收益不匹配 | Aider 自己只在 ContextWindowExceededError 时触发 |
| 移除 nudge | LLM 不会主动用工具 | DCP Issue #449; When2Tool |
| Message ID 注入 | 前台干扰，keep_recent 可覆盖 90% 场景 | DCP Issue #573 feedback loop |
| 持久后台进程 | OpenCode 架构不支持 | subagent 调研 |

---

## 9. 依赖

- **不依赖 omo**: `<system-reminder>` 是纯文本；threshold/cooldown/PostCompact 是通用模式
- **不依赖外部包**: 所有功能用现有 deps（@opencode-ai/plugin SDK）
- **依赖 OpenCode SDK**: `client.session.create` + `client.session.promptAsync` + `client.session.messages`

---

## 10. Grill 审计修正（3 轮 × 12 项）

### 高严重性修正（必须改）

**修正 #2 (P1 summary block 消息类型)**:
原设计：splice 一个 user-role 消息。但 messages.transform 注释写死 "User messages are NEVER touched"——虽然这是压缩代码的自我约束，OpenCode SDK 是否容忍 splice 新消息未知。
**修正**: summary block 改为 assistant-role（`info: { role: "assistant" }`），标注 `[compressed-block:...]`。assistant 消息的 text part 可以自由修改（V4 已经在做）。

**修正 #3 (P1 stale read 检测)**:
原设计：用 `tracker.getRecentlyRead()` 判断文件是否被编辑。实际：`RepoMapTracker` 没有 edit 跟踪能力。
**修正**: 用 `PluginState._recentEdits`（Set<string>）替代。如果 read 的文件路径在 `_recentEdits` 中，标记为 stale。

**修正 #8 (P0 子 session 整理期间 memory_store 竞态)**:
原设计：子 session 完成后直接覆盖 MEMORY.md。风险：用户在期间调了 memory_store。
**修正**: 写入前检查 MEMORY.md mtime。如果 mtime ≠ 子 session 启动时的 mtime，放弃 LLM 结果（log warn "MEMORY.md changed during consolidation, discarding LLM result"），SimHash dedup 仍然生效。下次 compaction 重新整理。

### 中严重性修正（应该改）

**修正 #1 (P0 SessionClient interface)**:
compacting.ts 的 `SessionClient` 只有 `session.messages`，缺 `session.create` 和 `session.promptAsync`。
**修正**: 扩展 interface：
```typescript
interface SessionClient {
  session: {
    messages(opts: {...}): Promise<{...}>;
    create(opts: {...}): Promise<{ data?: { id: string } }>;
    promptAsync(opts: {...}): Promise<void>;
  };
}
```

**修正 #5 (P0 子 session 时序)**:
子 session 在第一次 compaction 时创建。下次 compaction 时检查是否完成。如果用户在两次 compaction 间关闭 OpenCode，子 session 丢失。
**修正**: pendingConsolidation 持久化到 `.deep-memory/.pending-consolidation.json`。`session.created` 事件检查并重试。

**修正 #6 (P1 合成消息结构)**:
OpenCode 消息有 `{ info: { role, id, ... }, parts: [...] }`。合成消息缺 id 等字段。
**修正**: 最小化结构 `{ info: { role: "assistant" }, parts: [{ type: "text", text: "..." }] }`。E2E 测试验证 SDK 容忍。

**修正 #9 (P3 nudge threshold)**:
原设计用百分比（70%/90%）。但 `detectPressure` 的 token 估算在无 step-finish 时误差 30%。
**修正**: 用绝对 token 阈值。70K → threshold nudge；90K → emergency nudge。复用 V4 的 `detectPressure` 返回的 `estimatedTokens`。

**修正 #10 (P2 keep-pattern)**:
原设计移除 bullets + numbered lists。风险：步骤序列（`1. Do X\n2. Do Y`）被压缩后只剩 heading。
**修正**: 只移除 bullets（`^\s*[-*]\s`），保留 numbered lists（`^\s*\d+\.\s`）。触发率预估从 25% → 40%（不是 55%）。

### 低严重性修正（可以改）

**修正 #4 (P3 injectIntoLastToolResult fallback)**:
最后一条消息可能是 assistant text，不是 tool result。
**修正**: 先找最后一个 tool result；如果没有，fallback 到最后一条 assistant text。

**修正 #7 (P1 summary 质量差)**:
LLM 写的 summary 可能漏关键信息。
**修正**: context_compress 的 tool result 返回所有被压缩消息的 CCR hash 列表，LLM 可以逐个调 deep_expand 恢复。

### 修正后的验证标准

| 模块 | 可证伪指标 | Grill 修正影响 |
|---|---|---|
| P0 | 子 session 完成 + MEMORY.md 行数不增长 + mtime 竞态检测 | 加 #8 mtime 检查 |
| P1 | summary block 注入 + content-type 分类 + CCR hash 可恢复 | 改 #2 assistant role + #3 PluginState._recentEdits |
| P2 | 触发率 25% → 40% | 改 #10 只移除 bullets |
| P3 | 70K token 触发 + cooldown 生效 | 改 #9 绝对阈值 |

### dream/distill 教训对照

| V2 失败原因 | P0 是否有同样风险 | Grill 修正 |
|---|---|---|
| 7 天周期触发 | ❌ 每次 compaction | - |
| notes.md 空 | ❌ 读 checkpoint.md | - |
| fire-and-forget 无检查 | ❌ 下次 compaction 检查 | - |
| queuedDream 重试 bug | ❌ pendingConsolidation 持久化 | 加 #5 文件持久化 |
| 主进程关闭则子 session 死 | ⚠️ 同样依赖 | 加 #5 session.created 重试 |
| 子 session 结果覆盖新写入 | V2 没这个问题 | 加 #8 mtime 检查 |

---

## 11. 补充：3 个 Momus 未覆盖的设计缺口

### 11.1 P0 子 session model 选择

**决策**: 使用项目默认 model（`client.session.create` 继承项目配置）。

**证据**:
- `client.session.create` 没有 model 参数——新 session 继承项目配置（dream-executor.ts V2 也是如此）
- Claude Code 的 reactiveCompact 使用主 model
- Aider 的递归摘要使用主 model
- Mem0 用独立 manager LLM——但 Mem0 是每次 add() 都触发（高频），我们是每次 compaction 才触发（低频）

**成本分析**:
- MEMORY.md 上限 200 行 ~5K tokens input
- LLM 整理输出 ~5K tokens
- 每次 compaction ~10K tokens 调用
- 用户每天可能 compaction 2-5 次 = 20-50K tokens/天
- 在典型 model 定价下（$1-3/M tokens）= $0.02-0.15/天——可忽略

**不可配**：SDK 不支持在 session.create 时指定 model。如果未来 SDK 支持，可以加 `DEEP_MEMORY_CONSOLIDATION_MODEL` 环境变量。

### 11.2 P3 nudge 阈值——绝对 token（与 V4 pressure.ts 一致）

**关键事实**（来自 `src/compress/pressure.ts` + Context Rot 研究）：
- `OPENCODE_COMPACTION_RATIO = 0.75`——OpenCode 在 context 75% 时触发 compaction
- V4 已用绝对阈值：`PRESSURE_MEDIUM_TOKENS = 50K`，`PRESSURE_HIGH_TOKENS = 150K`
- **Context Rot（Chroma 2025）**：所有 18 个测试模型随 token 增加降质，1M context 模型 ~200K 后明显变差
- **绝对 token 校准的是质量降质拐点，不是 context 大小**——ratio 在 1M context 上等 500K 才触发（早已过质量悬崖），绝对值在 50K 触发（两种 context 都安全）

**推导**:
```
LLM 质量拐点 ≈ 200K tokens（Context Rot）
↓
threshold nudge 应远早于拐点 → 50K（V4 MEDIUM，25% of 拐点）
↓
emergency nudge 在 compaction 之前 → 120K（80% of V4 HIGH 150K，compaction 前 headroom）
```

**决策**:
| Nudge | 阈值 | 依据 |
|---|---|---|
| Threshold | `estimatedTokens >= 50K` | V4 MEDIUM——远早于 200K 质量拐点，给 LLM 充分时间主动压缩 |
| Emergency | `estimatedTokens >= 120K` | 80% of V4 HIGH (150K)——compaction 前最后窗口 |

**为何不用 ratio**：1M context 上 ratio 0.5 = 500K，早已过质量悬崖。绝对 token 在所有 context 大小下行为一致——V4 pressure.ts 注释已论证。

**实现**：用 `detectPressure()` 返回的 `estimatedTokens` 字段，直接比较绝对值。

### 11.3 回归基准——怎么证明 V5 比 V4 好

**基准设计**：同一个标准化测试 session 跑 V4 和 V5，对比 4 类指标。

#### 指标 1: 压缩有效性（P1/P2 验证）

| 指标 | V4 baseline | V5 目标 | 测量方法 |
|---|---|---|---|
| compressAssistantText 触发率 | 25% | ≥ 40% | benchmark 脚本计数 triggered/eligible |
| assistant bytes 压缩比 | 19.3% | ≥ 35% | compressed_bytes / total_assistant_bytes |
| context_compress 内容感知率 | N/A | 100% | 所有压缩消息有 content-type 分类 |
| CCR 恢复成功率 | 100% | 100% | deep_expand hash 返回原文 |

#### 指标 2: 输出质量（V5 核心目标——不能比 V4 差）

| 指标 | V4 baseline | V5 目标 | 测量方法 |
|---|---|---|---|
| 空代码块频率 | 待测 | ≤ V4 | 构造 50 轮 session，计数空 ``` blocks |
| 占位符泄漏 | 0 | 0 | 检查 LLM 输出是否包含 [OUTDATED] / deep_expand |
| system prompt byte-stability | 100% | 100% | 连续 N 轮 system prompt SHA-256 不变 |

#### 指标 3: Nudge 有效性（P3 验证）

| 指标 | V4 baseline | V5 目标 | 测量方法 |
|---|---|---|---|
| context_compress 调用率（nudge 后） | N/A | ≥ 50% | nudge 触发后 LLM 是否在 3 轮内调 context_compress |
| threshold nudge 频率 | N/A | 每 session ≤ 1 次 | cooldown 验证 |
| emergency nudge 频率 | N/A | 每 session ≤ 3 次 | 直到 compress 或 compaction |

#### 指标 4: 记忆整理（P0 验证）

| 指标 | V4 baseline | V5 目标 | 测量方法 |
|---|---|---|---|
| MEMORY.md 语义重复条目 | 待测 | ≤ 2 | 构造 10 对语义重复，consolidation 后计数 |
| consolidation 成功率 | N/A | ≥ 80% | 子 session 完成 + 结果通过格式验证 |
| 数据丢失 | N/A | 0 | 所有唯一条目 consolidation 后仍存在 |
| mtime 竞态检测 | N/A | 100% | 并发 memory_store + consolidation 测试 |

#### 基准脚本

```bash
# 跑 V4 baseline（当前 dist/index.js）
node /tmp/v4-compress-bench.mjs > v4-results.json

# 实施 V5 后
node /tmp/v4-compress-bench.mjs > v5-results.json

# 对比
node /tmp/compare-bench.mjs v4-results.json v5-results.json
```

每个 Phase 完成后跑一次，确认指标朝目标移动。如果某个指标退化——停止，调查原因。

---

**文档版本**: 3.0 (post-Momus + 补充)
**Grill 轮数**: 3 轮自审 + 1 轮 Momus 独立审计
**修正数**: 10 项 grill + 3 项补充 = 13 项
