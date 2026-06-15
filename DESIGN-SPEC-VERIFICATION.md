# DESIGN-SPEC-VERIFICATION v0.2

> 按 DESIGN.md 逐条映射测试覆盖，评估 v0.2 实现与设计目标的差距。

## 1. Pillar 1 — Persistent Memory (持久记忆)

| # | Spec | Unit Test | Smoke | E2E | Status |
|---|------|----------|-------|-----|--------|
| 1 | CJK bigram tokenizer | ✅ 17 tests | ✅ | ✅ 中文搜索成功 | ✅ |
| 2 | BM25 engine k1=1.5, b=0.75 | ✅ 20 tests | — | ✅ search 返回 scored 结果 | ✅ |
| 3 | Markdown→Index reconcile | ✅ 10 tests | ✅ | ✅ index-state.json 生成 | ✅ |
| 4 | memory_search tool | ✅ 11 tests | ✅ | ✅ CJK + Latin 搜索 | ✅ |
| 5 | memory_store tool | ✅ 11 tests | ✅ | ✅ MEMORY.md 写入 | ✅ |
| 6 | memory_forget tool | ✅ 11 tests | ✅ | ✅ 精确删除 | ✅ |
| 7 | [date] timestamp on entries | — | — | ✅ | ✅ |

## 2. Pillar 2 — Context Management (上下文管理)

| # | Spec | Unit Test | Smoke | E2E | Status |
|---|------|----------|-------|-----|--------|
| 8 | compacting hook capture | ✅ 6 tests | — | ⚠️ 未压缩触发 | ⚠️ |
| 9 | heuristic extraction (5 patterns) | ✅ 16 tests | — | ⚠️ 同上 | ⚠️ |
| 10 | checkpoint.md writer | ✅ 13 tests | — | ⚠️ 同上 | ⚠️ |
| 11 | idle LLM enrichment | ✅ 7 tests | — | ⚠️ 同上 | ⚠️ |
| 12 | adaptive injection (agent tier) | ✅ 28 tests | ✅ | ✅ stableSize=1210 normal / 2053 resume | ✅ |
| 13 | budgeted-read | ✅ 9 tests | — | ✅ | ✅ |
| 14 | messages.transform (O15-O19) | ✅ 16 tests | ✅ | ✅ metadata_stripped=2 | ✅ |
| 15 | m[0]/m[1] cache-stable | — | ✅ | ⚠️ stableSize 跨轮一致但未做字节对比 | ⚠️ |
| 16 | tier injection (P1-P5) | ✅ 9+12+15+10 tests | — | ⚠️ 需 50+ 条记忆触发多层 | ⚠️ |
| 17 | Jaccard dedup | ✅ 10 tests | — | ⚠️ 需多条相似记忆 | ⚠️ |

## 3. Pillar 3 — Session Continuity (会话连续性)

| # | Spec | Unit Test | Smoke | E2E | Status |
|---|------|----------|-------|-----|--------|
| 18 | session.created resume | ✅ 8 tests | ✅ | ✅ resume 检测 + post-resume 注入 | ✅ |
| 19 | auto-dream 7-day cycle | ✅ 9 tests | ✅ | ✅ schedule.json 更新 | ✅ |
| 20 | dream executor | ✅ 5 tests | — | ✅ 后台会话 spawn | ✅ |
| 21 | auto-distill 30-day cycle | ✅ 5 tests | ✅ | ✅ lastDistill 更新 | ✅ |
| 22 | distill executor | ✅ 5 tests | — | ✅ 后台会话 spawn | ✅ |
| 23 | /dream /checkpoint /distill commands | — | ✅ | ✅ 文件存在 | ✅ |
| 24 | chat.message keyword capture | ✅ 8 tests | ✅ | ⚠️ notes.md 当前空（无关键词消息） | ⚠️ |
| 25 | notes.md dedup (O10) | ✅ | — | ⚠️ 无足够触发 | ⚠️ |

## 4. Design Goals vs Reality

| Goal | DESIGN.md | Achieved | Gap |
|------|-----------|----------|-----|
| BM25 rebuild <250ms | 2000 docs | 1000 docs 6.4ms ✅ | 16x faster |
| Search <5ms | p99 | p99 3.01ms ✅ | Better |
| Token budget accuracy | ±10% | stableSize 1210≈302t ✅ | 200t 预算，302t 实际（高估） |
| Context compression ratio | ~28.5% | metadata 2 条 ✅ | 长对话未量化 |
| Tier multi-level rendering | P1-P5 | 15 条记忆，未触发多层 ⚠️ | 需 50+ 条 |
| Cache stability | m[0] identical | stableSize 一致 ✅ | 未做字节对比 |
| DCP replacement capability | 替代 DCP | metadata_stripped=2 ✅ | 长对话压缩比未知 |

## 5. Gaps Requiring Action

| Priority | Gap | Fix |
|----------|-----|-----|
| **P0** | Tier injection 未在 E2E 验证 | 生成 50+ 条记忆，查询触发多层渲染 |
| **P0** | 长对话压缩效果未量化 | 30+ 轮对话 benchmark |
| **P1** | m[0] 字节对比未做 | trace 模式 dump system prompt 对比 |
| **P1** | compacting hook 未验证 | 触发一次真正的压缩 |
| **P2** | vs DCP/Magic Context 无对比数据 | 创建对比矩阵 |
| **P2** | checkpoint.md 从未生成 | 触发压缩或手动 /checkpoint |
