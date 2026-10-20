# Stage 4 — 缓存工作与摘要插入位置决策记录

- **日期**：2026-10-20
- **范围**：方案 Stage 4「messages-transform 缓存工作」三项
- **证据脚本**：`scripts/measure-summary-placement.mts`（`npm run measure:summary-placement`，纯本地、不需要引擎）
- **相关**：`docs/research/v2-032-respike.md`（v2 宿主实测）、`CHANGELOG.md`（0.16.1）

## 0. 三项结论一览

| 项 | 方案原文要求 | 结果 |
|---|---|---|
| 1 | Gate `maybeProactiveExpand`，它会把压缩内容「还原」进历史、从而作废前缀 | ✅ **已实现**：注记改挂尾部并幂等 |
| 2 | nudge 每轮重写尾部（隐含于「缓存友好」目标） | ✅ **已实现**：按种类标记幂等 |
| 3 | `Replace the summary-block mid-array splice with append-then-cut` | ⚠️ **部分实现 + 偏离**：条件化。压缩发生 → 保留拼接（实测该位置**免费**）；未压缩 → 改为追加（实测省 8 条 / 656 字符）。逐字替换拼接被实测否决，理由见 §3 |

**偏离需要用户裁定的一项**：第 3 项没有按字面把 `messages.splice(cutoff, 0, summaryMsg)` 整体换成追加。依据是实测数据（§3.3），而不是偏好。若你要求必须逐字替换，改动很小，但会把「未压缩场景」之外的语义顺序一起改掉，且实测无收益。

## 1. proactive-expand 注记改挂尾部（已实现）

**原行为**：`annotateToolOutput()` 把最多 3 KB 的恢复内容**原地追加到被压缩的那条 tool 输出**里。该消息位于历史中段，因此这次改动会使其后**每一条**消息都无法命中前缀缓存——为了注入 3 KB 而可能重付整段会话。

**新行为**：注记改挂**最后一条 user 消息**（`annotateLastUserMessage()`）。代价被限制在「实际新增的字节」上，因为尾部之后没有内容会被推移。同时加了幂等标记 `[auto-restored:<hash>]`：transform 在一次 tool loop 内每个请求都会跑，不设标记会重复追加、反而改写它在保护的尾部。

**测试**：`tests/hooks/compression-inject.test.ts` 断言压缩输出**未被改动**、注记落在 user 消息上、且第二次 pass 返回 0 且字节不变。

## 2. nudge 注入幂等（已实现）

**原行为**：nudge 文本被追加到「最后一条 tool 输出」的 `state.output`。emergency 档（`estimated >= 120K`）**每次请求**都会触发，而 transform 每个请求跑一次，所以同一段文本被反复追加：输出无上限增长，且每一轮都改写尾部、每轮付一次本可避免的 cache miss。

**新行为**：按 nudge **种类**设置稳定标记前缀（`NUDGE_MARKER_POSTCOMPACT` / `_EMERGENCY` / `_THRESHOLD`），已存在则不再追加。标记必须是「种类」而不是渲染后的文本——emergency/阈值文本内嵌 token 数，每轮都不同，无法自我标记。新出现的 tool 输出仍会拿到一条新 nudge，信号不丢失。

**测试**：`tests/hooks/nudge-idempotency.test.ts`（post-compact 路径可确定性触发，无需构造 600 KB 消息体）。

## 3. 摘要块插入位置（条件化实现 + 实测偏离）

### 3.1 方案假设

方案把 `messages.splice(cutoff, 0, summaryMsg)` 描述为「shifts every later message and invalidates the whole tail」，据此要求换成 append-then-cut。

### 3.2 实测方法

`scripts/measure-summary-placement.mts` 驱动**真实的** `createMessagesTransformHandler`，然后以「前缀缓存」的真实语义打分：缓存匹配的是**从头开始的连续前缀**，所以**第一条不同的消息下标**就是仍可从缓存复用的最后位置，其后全部需要重新 prefill。四个变体全部由同一次 pass 的中间态派生，因此只差摘要的位置：

- `A` 在 `cutoff` 处拼接（原实现）
- `B` 追加到数组末尾（append-then-cut 的字面读法）
- `C` 追加到压缩区最后一条消息上（「不产生下标位移」）
- `D` 完全不插入
- `SHIPPED` 实际实现：压缩发生则 `A`，未压缩则 `B`

### 3.3 实测结果（`cachedPrefix` = 仍可命中缓存的消息条数）

**S1 — 真实场景：压缩确实改写了历史**

| 变体 | cachedPrefix | 需重新 prefill | 相对 A |
|---|---|---|---|
| A 拼接 | 2 | 17 条 / 7202 字符 | 0 |
| B 追加末尾 | 2 | 17 条 / 7202 字符 | **0** |
| C 追加到压缩区末条 | 2 | 17 条 / 7202 字符 | **0** |
| SHIPPED | 2 | 17 条 / 7202 字符 | **0** |

**四个变体完全并列**。原因：分歧点由压缩改写本身决定（下标 2 起），插入位置根本不在分歧点上。**在压缩真正发生的一切场景里，插入位置是免费的**——这正是方案假设不成立的地方。

**S2 — 退化场景：压缩区没有任何可改写内容**

| 变体 | cachedPrefix | 需重新 prefill | 相对 A |
|---|---|---|---|
| A 拼接 | 13 | 8 条 / 656 字符 | 0 |
| B 追加末尾 | 21 | 0 条 / 0 字符 | **−8 条 / −656 字符** |
| C 追加到压缩区末条 | 12 | **9 条 / 738 字符** | **+1 条 / +82 字符（更差）** |
| SHIPPED | 21 | **0 条 / 0 字符** | **−8 条 / −656 字符** |

三条要点：

1. 只有当插入是该 pass **唯一**的改动时，位置才产生影响。此时拼接会重付整个受保护尾部（8 条 / 656 字符）。
2. **`C`（「不产生下标位移」）比拼接更差**——这是我最初的直觉推断，被实测推翻：把摘要挂到压缩区最后一条消息上，分歧点上移到 `cutoff−1`，反而多付一条。
3. 只有追加到数组末尾能让 `cachedPrefix` 走到 21（仅摘要本身是新的）。

### 3.4 实际实现

```ts
if (compressed > 0) {
  messages.splice(cutoff, 0, summaryMsg as never);   // 有序，且实测免费
} else {
  messages.push(summaryMsg as never);                // 唯一改动的场合，零前缀代价
}
```

并把「标记压缩区旧 assistant 消息」的循环**前移**到插入之前，使这个判断基于本 pass 的真实结果（`compressed` 同时涵盖 tool 输出替换与 assistant 文本标记）。压缩未发生时，摘要**不被丢弃**——它被放到末尾：此时没有「被压缩的块」可供它前置，顺序前提本就不成立，而代价为 0。这保住了 agent 通过 `context_compress(summary=...)` 注入的信息。

**测试**：`tests/hooks/summary-placement.test.ts` 三条——压缩发生时分块位于 `cutoff` 且其前是压缩区；未压缩时位于 `before.length`（追加）且受保护尾部**逐条字节不变**；任何路径下摘要块恰好一条。

### 3.5 偏离记录（供裁定）

- **方案原文**：「Replace the summary-block mid-array splice (`messages.splice(cutoff, 0, summaryMsg)`, which shifts every later message and invalidates the whole tail) with append-then-cut」
- **偏离内容**：`splice` **仍然存在**，但被条件化——只在压缩真正发生（`compressed > 0`）时使用；此时实测显示它免费。append 被用在它唯一有价值的场合。
- **依据**：§3.3。字面替换（S1 也走 B）实测 **收益为 0**，却把摘要移到最新一条 user 消息之后，破坏该块存在的目的（「[compressed-block: messages 1-N] 紧随其后是被保留的尾部」这一叙述顺序）。
- **残余风险**：未发现。审阅者若要核对，`npm run measure:summary-placement` 可复现全部数字，`SHIPPED` 行即实际实现。
- **若要求逐字替换**：把 `if (compressed > 0)` 分支删掉、只保留 `push` 即可；实测 S1 不变、S2 不变，代价是顺序语义。

## 4. 复现

```bash
npm run measure:summary-placement   # 输出 S1/S2 两张表，无需引擎
npx vitest run tests/hooks/summary-placement.test.ts tests/hooks/proactive-expansion.test.ts \
               tests/hooks/compression-inject.test.ts tests/hooks/nudge-idempotency.test.ts
```

## 5. 遗留项

1. 两个场景是合成构造。真实会话里「压缩区只含 user 消息」的形状是否常见，未统计——影响的是 §3.3 S2 的权重，不影响结论（S1 全并列、C 更差这两点与场景无关）。
2. `compressed === 0` 但存在摘要时，摘要落在最新一条 user 消息之后。模型可依据 `[compressed-block: messages 1-N]` 标签定位它，但这一步未经真实 LLM 效果评估。
3. 前缀命中率仍是**复用率代理指标**：stub LLM 不填充引擎的 `tokens.cache.read`，真实计费命中率需要真 provider（同 `v2-032-respike.md` §7 的说明）。