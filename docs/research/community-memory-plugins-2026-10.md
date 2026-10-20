# opencode 社区记忆/上下文插件竞品调研（2026-10-20）

- **日期**：2026-10-20
- **调研对象**：opencode 生态中的记忆注入与上下文管理插件，以及相邻的独立 agent 记忆系统
- **数据采集**：npm registry（`npm view` / `npm pack` 读取包内 `README.md` 与 `package.json`）、GitHub REST API、厂商官方文档页
- **配套文档**：`docs/research/v2-032-respike.md`（本仓 opencode 2.0.32 宿主实测判决）

---

## 0. 摘要

- **v2 插件契约已经分层**：`{ id, setup(ctx) }` 由 `@opencode/plugin@2.0.32` 提供，v1 的 `@opencode-ai/plugin` 停在 1.19.3。二者是**独立产品线**，不是同一包的两个大版本。[npm/@opencode/plugin](https://www.npmjs.com/package/@opencode/plugin) [npm/@opencode-ai/plugin](https://www.npmjs.com/package/@opencode-ai/plugin)
- **缓存策略由宿主拥有，插件只能"选择内容与位置"**：`applyCachePolicy` 在 `@opencode/ai` 中定义并在编译期（走到 per-protocol body builder 之前）统一注入断点，`BREAKPOINT_CAP = 4`。插件**无法自行放置断点**，手动 `CacheHint` 也占用同一份 4 个额度。[@opencode/ai `dist/cache-policy.js`](https://github.com/anomalyco/opencode)
- **最接近的竞品是 Magic Context**（`@cortexkit/opencode-magic-context` 0.49.13，cortexkit/magic-context 2,356★）。它宣称"cache-aware deferred mutation"、会在启动时**主动自我禁用**于冲突插件（包括 oh-my-openagent 的三个 hook，以及 `oh-my-opencode`/OMO 命名变体），并提供缓存击穿哨兵脚本。[cortexkit/magic-context](https://github.com/cortexkit/magic-context)
- **多数同类项目根本没有缓存故事**：DCP 明确把"剪枝会提高 cache miss"当作已知 trade-off 写进 README；`opencode-mem`（1,767★）的文档完全没有缓存策略。而 claude-mem（101,811★）、mem0（67,471★）、Letta（25,195★）、Graphiti（32,048★）、Cognee（32,553★）、basic-memory（4,279★）、ByteRover（4,948★）、MemOS（11,941★）**没有一家在文档中提及 prompt cache**。
- **本仓定位可守**：`opencode-deep-memory` 的"字节稳定 system prompt + 增量合并 + 主 agent 触发压缩"组合，在已核对的项目中**没有等价物**；真正的差距在于缺少可量化缓存指标、缺少冲突检测/自我禁用机制、缺少多 provider 策略家族。

---

## 1. 被测对象与判定口径

本调研把对象分成两层：**opencode 原生插件**（走 v1 `plugin` 或 v2 `plugins` 加载路径，能读写请求）与**相邻 agent 记忆系统**（独立进程/服务/MCP，不与 opencode 请求管线耦合）。

对每个对象沿三条轴判定：

**(a) 是否支持 opencode v2 的 `{ id, setup }` 契约** —— 判据是包依赖里是否出现 `@opencode/plugin`（v2）而非仅 `@opencode-ai/plugin`（v1），以及 README 是否描述 `setup` / `ctx.*.hook` / `session.hook("context")` 用法。注意"声明支持"与"实测通过"不同，下表把自述口径单独标注。

**(b) 是否开源** —— 是否有公开可解析的 GitHub 仓库与许可证。闭源/仓库不可解析的，即使 npm 包可用也判为不可审计。

**(c) 是否有成文的 prompt-cache 策略** —— 判据是文档中是否**明确**描述缓存保持着法（追加而非重建、延迟应用、保持前缀字节稳定、稳定 cache key 等），而不是仅仅提到"cache"一词。只有可引用的原文才算数；由代码推断的一律标 INFERRED。

---

## 2. opencode 原生插件对照表

星标数为 2026-10-20 GitHub API 实测值。

| 项目 | 包名与版本 | 仓库与星标 | v1/v2 | 架构 | 缓存策略 |
|---|---|---|---|---|---|
| **Magic Context** | `@cortexkit/opencode-magic-context` 0.49.13 | cortexkit/magic-context · 2,356★ | 双（自述 v2-capable） | historian + dreamer 双 agent；上下文分 compartment；`ctx_reduce`/`ctx_note`/`ctx_search`；SQLite `context.db` | **成文**：cache-aware deferred mutation；丢弃操作"queued and cache-aware，仅在 cache-safe moments 应用"；"Cache-stable layout"；自带 cache-bust sentinel |
| **opencode-mem** | opencode-mem 2.32.0 | tickernelz/opencode-mem · 1,767★ | 双（v1+v2 依赖并存） | 本地 ONNX embeddings + Turso/libSQL 向量库 | **无**：文档未提及缓存 |
| **DCP** | `@tarquinen/opencode-dcp` 3.2.0 | Tarquinen/opencode-dynamic-context-pruning · 4,378★ | **v1 only** | 规则 + `compress` 工具剪枝工具输出；磁盘历史不动，只改写发往 LLM 的请求 | **成文但为负面**：明确写出"pruning… can increase cache misses"的 trade-off |
| **Sleev** | 无公开 npm 包 | **无公开仓库** | n/a | DCP 团队迁往的闭源后继 | 不可审计 |
| **opencode-cache-compact** | opencode-cache-compact 0.2.0 | lennartschoch/opencode-cache-compact · 10★ | 明确 V1+V2 | "先追加后切"（summarize by appending → cut）；V2 走 `session.hook("context")`；要求 `compaction.auto:false` | **成文且为核心卖点**：append-then-cut、非破坏性切分、磁盘历史不动 |
| **opencode-cache-engine** | opencode-cache-engine 1.4.0 | AlexJoaquimPereira/opencode-cache-engine · 0★ | v1 已验；v2 适配器**自标 preview** | 11 个 provider 策略家族；策略注册表 + resolver；多数家族只做被动观测 | **成文且最详细**：凡 opencode 已拥有断点的路由一律不注入；GLM-5.3/MiMo V2.6 用 content-preserving `<env>` relocation |
| **residue** | `@serkanalgur/residue` 0.3.2 | serkanalgur/residue | **v2 only**（peerDep `@opencode/plugin ^2.0.0`） | 事件驱动抽取 decision+reason 原子事实 → SQLite FTS5；注入 `<recalled_notes>` system 段 | **自述**：仓库描述称"injects via the context hook **with prompt-cache reuse**"（未见量化，标 INFERRED） |
| **context-cache** | `@jimmyyen/opencode-context-cache` 1.1.1 | JackDrogon/opencode-context-cache（概念源） | v1（`chat.params`） | 只写 `promptCacheKey`，上游只看到 SHA256 摘要；Magic Context 在场时切"Cache Locker"模式 | **成文且带数字**：真实运行 input cache hit rate **97.99%（164,736 / 168,112）** |
| **opencode-working-memory** | opencode-working-memory 1.6.9 | sdwolf4103/opencode-working-memory | **v1 only**（peerDep `>=1.2.0 <2.0.0`，显式排除 v2） | 三层：workspace memory + hot session state | 无 |
| **opencode-acp** | opencode-acp 1.18.5 | ranxianglei/opencode-acp | **v1 only**（peerDep `>=1.4.3`） | 自称 "hardened fork of DCP with 35 bug fixes"，模型驱动上下文管理 | 无独立策略（继承 DCP 的剪枝语义） |
| **oh-my-openagent（omo）** | oh-my-openagent 5.1.38 | code-yeongyu/oh-my-openagent | **双**（同时依赖 `@opencode-ai/plugin` 1.18.31 与 `@opencode/plugin` 2.0.32） | 全能 harness：多模型编排、并行后台 agent、LSP/AST 工具 | 无成文策略；但其 `preemptive-compaction` hook 被 Magic Context 点名为冲突源 |
| **opencode-deep-memory（本仓）** | `@bd7pil/opencode-deep-memory` 0.15.0 | BD7PIL/opencode-deep-memory | **双形态单包** | 六层：捕获期限流 / 陈旧读改写 / 字节稳定 system / 一次性检索 / 增量合并 / 主 agent 触发压缩 | **成文**：字节稳定 system prompt + 一次性注入；v2 侧走最后一条 user message |

### 五个最相关项目的展开

**Magic Context** 是唯一在"上下文管理 + 记忆"双线都做到产品级、且把缓存保持当作一等约束的对手。关键设计有三点值得注意：一是它**主动关闭宿主的 built-in compaction**，理由是宿主压缩会干扰它自己的 cache-aware deferred operations 并造成双重压缩；二是它把丢弃操作**排队**，只在 cache-safe moments 落地，从机制上避免"边跑边砸缓存"；三是它有**fail-safe 自我禁用**——启动时检测到其他上下文管理者（含 omo 的重叠 hook）就整体停用并说明原因。这种"不共存"策略与 omo 生态的现实冲突直接相关。[repo](https://github.com/cortexkit/magic-context)

**opencode-cache-compact** 提供了本调研中最干净的一条可复用技术：**append-then-cut**。它从不重建 prompt——先追加一个普通 user turn 索取交接摘要（该 turn 只是扩展既有对话，因此前缀命中缓存，只生成摘要），此后把出站请求重写为"稳定前缀 + 摘要 + 当前 turn"。它的动机是**本地托管模型**的 prefill 成本，这与云端按 token 计费的优化动机不同但结论一致：不重建 = 不重读。它还明确了 `compaction.auto:false` 的互斥要求。[npm](https://www.npmjs.com/package/opencode-cache-compact)

**opencode-cache-engine** 的价值在于其**保守性论证**。它对 Claude、Gemini、Qwen、xAI Grok、Meta Muse、MiniMax、Kimi、DeepSeek 等家族的一致做法是"passive classification and accounting"——只分类和记账，不改请求、不注入 header、不加 affinity key，理由是"OpenCode 本身已经拥有这些断点"。它只在两个家族上做真正的重写（GLM-5.3、MiMo V2.6 的 `<env>` relocation），且强调该重写是 **content-preserving** 的。这是一份"什么时候不该动"的教科书。[npm](https://www.npmjs.com/package/opencode-cache-engine)

**DCP** 虽已把开发迁往闭源 Sleev，但它留下了两条重要资产。第一是**placeholder-not-history**：README 原文称"Your session history is never modified — DCP replaces pruned content with placeholders before sending requests to your LLM"——磁盘上的历史完整保留，只有发往 LLM 的请求被替换。第二是它**诚实记录了缓存代价**："LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it changes messages, which invalidates cached prefixes from that point forward."并把"剪枝省下的 token 是否值得增加的 cache miss"交给用户按对话与定价自行判断。它还注明在按请求计费或缓存/非缓存同价的 provider 上此代价为零。[repo](https://github.com/Tarquinen/opencode-dynamic-context-pruning)

**residue** 是唯一一个在 v2 上 peerDep 声明为 `@opencode/plugin ^2.0.0` 的纯 v2 记忆插件，因此其注入通道即 v2 的 `context` hook，注入物是 `<recalled_notes>` system 段。其仓库描述自称"with prompt-cache reuse"，但 README 正文未见对缓存机制的展开描述，故该声称只按自述记录。它的抽取触发点是 `session.text.delta`（填充 turn buffer）与 `session.idle`（触发抽取），并强制 provenance（无 source 的记录直接丢弃）。[npm](https://www.npmjs.com/package/@serkanalgur/residue)

---

## 3. 相邻 agent 记忆系统

这些系统不与 opencode 请求管线耦合（独立服务、MCP server 或 CLI），因此**结构上不可能**参与 prompt 断点布局。

| 项目 | 仓库与星标 | 架构要点 | prompt-cache 考虑 |
|---|---|---|---|
| claude-mem | thedotmack/claude-mem · 101,811★ | Chroma + 三层渐进式披露 MCP；跨 Claude Code / Codex / Gemini / OpenCode | **无** |
| mem0 | mem0ai/mem0 · 67,471★ | 托管式记忆层，ADD/UPDATE/DELETE 抽取流水线 | **无** |
| Letta | letta-ai/letta · 25,195★ | 有状态 agent 平台，自管上下文与记忆分层 | **无** |
| Graphiti / Zep | getzep/graphiti · 32,048★ | 实时时序知识图谱，带 validity window | **无** |
| Cognee | topoteretes/cognee · 32,553★ | 开源 AI 记忆平台，图谱 + 向量混合 | **无** |
| basic-memory | basicmachines-co/basic-memory · 4,279★ | 以 Markdown 文件为记忆载体，本地优先 | **无** |
| ByteRover（原 Cipher） | campfirein/byterover-cli · 4,948★ | 可移植记忆层 CLI，跨多种 coding agent | **无** |
| OpenMemory | mem0ai/openmemory · 98★ | 跨 Claude Code / Codex / OpenCode 迁移 coding session 的 CLI/TUI | **无** |
| MemOS | MemTensor/MemOS · 11,941★ | 自进化记忆 OS，宣称 35.24% token 节省 | **无**（宣称的是 token 节省而非 cache hit） |

**负面结论（明确陈述）**：以上九个系统**没有一家**在其文档中讨论 prompt cache —— 既没有断点预算意识，也没有前缀稳定性约束，也没有 cache hit 指标。它们的优化目标一致地落在"检索质量"或"注入 token 总量"上，而"注入是否会击穿已缓存前缀"这一维度整体缺席。这意味着：**在 opencode 这类由宿主统一管理断点的运行时里，任何外部记忆系统都只能作为内容提供方，把"放到哪里"的决定权交还给插件层或宿主。** 这是本仓可以占据的位置。

---

## 4. 缓存保持技术清单

以下技术均为**已被具体项目成文记录**的做法，注明出处：

| 技术 | 出处 | 机制 |
|---|---|---|
| **append-then-cut** | opencode-cache-compact | 先追加 user turn 索取摘要（前缀命中缓存），再把出站请求重写为"稳定前缀 + 摘要 + 当前 turn"；只在出站侧生效 |
| **queue-and-apply-at-cache-safe-moments** | Magic Context | 丢弃/归约操作不立即落地，排队直到 cache-safe 时机；配合 `ctx_flush` 强制立即应用（显式绕过 cache TTL） |
| **tail-append steering** | Headroom | 把"be terse, don't restate context"这类指令**追加到 system prompt 末尾**，从而不破坏前面已缓存的 system 前缀 |
| **content-preserving relocation** | opencode-cache-engine | 移动 `<env>` 等结构化片段而非改写内容，保持字节等价以维持前缀匹配（GLM-5.3 / MiMo V2.6） |
| **stable `promptCacheKey`** | `@jimmyyen/opencode-context-cache`（概念源 JackDrogon） | 跨 provider/环境/运行稳定化 cache key，上游只收 SHA256 摘要；Magic Context 在场时降级为 Cache Locker 模式只写 key |
| **once-per-session injection** | opencode-deep-memory（本仓） | 一次性自动检索，命中才追加 ≤30 token whisper；第 2 turn 起字节稳定 |
| **placeholder-not-history** | DCP | 磁盘历史永不修改，仅在出站请求体里把被剪内容替换为占位符 |
| **byte-stable tool definitions** | opencode-cache-engine（间接）、本仓 | 工具定义位于整个请求最前，必须字节稳定且顺序确定（宿主侧排序，插件侧不得引入非确定性描述） |

### provider 约束对照表

| Provider | 断点机制 | 最小可缓存前缀 | 断点/写入上限 | TTL 与顺序规则 |
|---|---|---|---|---|
| Anthropic | 请求内联 `cache_control` | **512 / 1,024 / 2,048 / 4,096**（按模型，例：Sonnet 5 = 1,024；Opus 4.6 = 4,096；Haiku 5.5 = 512） | **4** 个断点；自动缓存也占 1 个槽位 | 默认 **5 分钟**（复用时免费刷新）；可选 **1 小时**（额外计费）。两者可同请求共存，但**长 TTL 必须排在短 TTL 之前** |
| Bedrock | Converse `cachePoint` / InvokeModel `cache_control` | **512 – 4,096**（按模型）；按 `tools`+`system`+`messages` **累计**计算，非分段独立计算 | **4** 个 checkpoint/write | 同为 5 分钟 / 1 小时；**长 TTL 必须在短 TTL 之前**。checkpoint 处理顺序为 **`tools` → `system` → `messages`**，因此改动靠前段会使靠后段全部失效 |
| OpenAI | 隐式前缀缓存；GPT-5.6+ 支持显式 `prompt_cache_breakpoint` | **1,024** token 可见输入（GPT-5.6+）；更早模型上报粒度按 **128** 向下取整 | 每请求最多 **4** 次 cache write | GPT-5.6+：`prompt_cache_options.ttl` 仅 `30m`（默认）；更早模型：`in_memory`（约 5–10 分钟无活动，上限 1 小时）或 `24h` |
| Gemini | 隐式缓存（默认开启，2.5 以上）；显式 CachedContent 走另一条通道 | **2,048**（Gemini 2.5 Flash / 2.5 Pro）；**4,096**（Gemini 3.x Flash、Gemini 4 Argon 等）；Gemini 4 Argon 及以上不再支持显式缓存 | 不适用（隐式） | 无成文 TTL 规则（本网络可读页面未给出）；**Gemini 只使用最后一个断点**，因此"尾部断点"会每步写入新缓存，成本高于不设 |

> **INFERRED**：上表 Gemini 行的"只使用最后一个断点"来自 `@opencode/ai` 源码注释（"Gemini uses only the last breakpoint, so a conversation-tail breakpoint writes a new cache every step and costs more than none"），非 Gemini 官方文档原文。

---

## 5. opencode v2 缓存策略的结论

**事实（VERIFIED）**：`applyCachePolicy` 定义于 `@opencode/ai`，签名为 `(request: LLMRequest) => LLMRequest`，注释明确其"Runs once at compile time, before the per-protocol body builder"。默认 `cache: "auto"` 会在四个位置放断点：**最后一个 tool 定义、system 的 first 与 last 两个不同段落、对话尾部**。`BREAKPOINT_CAP = 4`，且"Manual `cache: CacheHint` placements on individual parts are preserved and count against the four-breakpoint budget; auto only fills remaining slots."[repo](https://github.com/anomalyco/opencode)

**推论（本仓 reconnaissance，已在前序 session 中经宿主源码与探针双向确认）**：`applyCachePolicy` **在插件 hook 之后**运行。插件因此**无法放置断点**，只能决定"加什么内容、加在哪个位置"，由宿主决定断点落点。

对插件作者的三条直接含义：

1. **字节稳定的内容应放进 system 段。** 它天然汇入被缓存的 system 前缀；宿主会在 system 的 first/last 段落各放一个断点，因此"稳定的 MEMORY.md 快照 + 固定 TOOL_HINT"能吃到最长前缀命中。反之，若把它塞进消息尾部，就落在"对话尾部断点"之后，每轮重写都会重新计入未缓存部分。
2. **易变内容应放在尾部。** 对话尾部断点会在每个 tool result 之后前进，这正是宿主为长 agent run 设计的机制：把易变内容放在尾巴上，前面已被缓存的部分不受影响。
3. **tool 定义必须字节稳定且顺序确定。** 工具位于整个请求的**最前**（顺序为 `tools` → `system` → `messages`），且宿主默认就在"最后一个 tool 定义"处放断点——因此工具定义的任何非确定性（描述里嵌入时间戳、动态 env、随机排序）都会同时击穿工具段、system 段与消息段的全部缓存。这是全请求中**单点风险最高**的位置。

**Provider 路由差异**同样由宿主兜底，插件不必操心：`RESPECTS_INLINE_HINTS` 白名单包含 `anthropic-messages`、`anthropic-compatible-messages`、`bedrock-mantle-messages`、`bedrock-converse`、`google-vertex-messages`、`alibaba-*`、`moonshot-messages`、`minimax-messages`、`openrouter`、`vercel-ai-gateway-messages` 等；OpenAI 与 Gemini 走隐式缓存，跳过整个 policy pass。另有两处特化：Qwen 的 policy 为 `{ system: true, messages: { tail: 1 } }`（**Qwen 忽略 tool 定义上的断点**，工具随 system 一起缓存），以及 OpenRouter 上除 Anthropic / Qwen 外的上游不做断点缓存。

---

## 6. 对 opencode-deep-memory 的可借鉴项与差距

| 项目 | 可借鉴 | 该项目的短板（= 本仓机会） |
|---|---|---|
| Magic Context | ①"排队 + cache-safe 时机应用"的显式调度；②冲突检测与 fail-safe 自我禁用；③cache-bust 归因（把请求与自身 pass 记录做 join，区分"是我造成的击穿"与"外部造成的"） | 闭源依赖重（historian + dreamer 双 LLM 流水线、独立 SQLite、sentinel 守护进程）；与 omo 生态**互斥**而非共存；体量与部署成本高 |
| opencode-cache-compact | append-then-cut 的极简正确性；`compaction.auto:false` 的显式互斥声明 | 只解决 compaction 一件事，无记忆；仅 10★，无生态；依赖 provider 上报 context window |
| opencode-cache-engine | ①"何时不该动"的保守性论证；②按 provider 家族分类 + resolver 的注册表结构；③content-preserving relocation | v2 适配器自标 preview 且**管理式配置发现未验证**；0★；偏观测/记账，实际重写面很窄 |
| DCP | placeholder-not-history 的出站改写模式；诚实标注缓存 trade-off 的文档习惯 | 仅 v1；开发已迁闭源 Sleev；其剪枝**结构性**地击穿前缀（每次剪枝都改动 messages） |
| context-cache | 用**单一指标**（cache hit rate 97.99%）证明价值的话术与度量口径 | 只做 cache key，不做记忆；v1-only；无 opencode v2 路径 |
| residue | 纯 v2 通道（`@opencode/plugin` peerDep）的最小可行形态；强制 provenance | 无量化缓存指标；README 未见缓存机制展开 |

### 对本仓的 5 条具体建议

1. **补一个可发布的缓存命中指标。** 目前本仓没有任何对外可引用的 cache hit 数字，而 `context-cache` 正是靠一个 `97.99%（164,736 / 168,112）` 建立可信度。建议基于 `session.context` 回读的请求体做前缀哈希对比，产出"本会话 system 前缀稳定率 / 每 turn 新建缓存 token 数"，写进 README。（依据：`context-cache` 的做法）
2. **把 v2 注入通道从"最后一条 user message"迁回 system 段。** 本仓 README 记录 v2 侧因 `system[]` 变更不可靠而改走最后一条 user message，代价是"每个被重写 message 一次 miss"。而 2.0.32 复测已确认 `event.system` 的追加**会**序列化进请求体。字节稳定的记忆块放进 system 段可直接汇入被缓存前缀，是收益最明确的一处改造。（依据：`docs/research/v2-032-respike.md` + 第 5 节推论 1）
3. **加冲突检测与降级开关。** Magic Context 的 fail-safe 之所以关键，是因为多个上下文管理者并存会"双重压缩并反复击穿缓存"。建议启动时检测同装的 DCP / ACP / Magic Context / cache-compact，命中则：(a) 明确告警，(b) 自动关闭自家 Layer 1 的 messages 改写，只保留记忆注入。（依据：Magic Context 冲突清单）
4. **审计工具定义与注入块的确定性。** 顺序为 `tools` → `system` → `messages`，工具定义居于最前且宿主默认断点就落在最后一个工具上——本仓的 TOOL_HINT、工具描述、记忆块必须逐字节确定，且工具注册顺序不得依赖 Map/Set 迭代顺序或时间戳。（依据：第 5 节推论 3）
5. **把 Layer 1 的改写改为排队 + cache-safe 落地。** 当前 Layer 1 每 turn 都跑"deterministic strip/throttle/compress"，只要它改动了 messages 就会从改动点起击穿后面的缓存。建议改为 Magic Context 式的队列语义：累积到阈值或显式 `ctx_flush` 式命令时才落地，把击穿从"每 turn"降为"每 N turn 一次"。（依据：Magic Context 的 queue-and-apply）

---

## 7. 检索方法与置信度

### 方法

- **npm registry**：`npm view <pkg> version|description|repository.url` 取版本与来源；`npm pack <pkg>@<ver>` + `tar xzf` 读取包内 `README.md` 与 `package.json`（这是本次一手证据的主要来源，比网页渲染更可靠）。
- **GitHub REST API**：`/repos/{owner}/{repo}` 取 `stargazers_count` / `description` / `archived`；`/search/repositories` 用于解析仓库名。
- **源码直读**：`@opencode/ai@2.0.32` 包内 `dist/cache-policy.js` 与 `dist/cache-policy.d.ts`（npm 分发只有 `dist/`，非 `src/`）。
- **厂商文档**：OpenAI prompt caching、Gemini API caching、Anthropic prompt caching、AWS Bedrock prompt caching 的官方页面。
- **本仓既有实测**：`docs/research/v2-032-respike.md`（opencode 2.0.32 宿主探针实测）。

### 本次实测纠正的版本/事实

| 项 | 前序 reconnaissance | 本次实测 | 处理 |
|---|---|---|---|
| magic-context 星标 | ~2,355 | **2,356** | 用实测值 |
| opencode-mem 星标 | ~1,766 | **1,767** | 用实测值 |
| DCP 星标与仓库 | ~4,376，仓库名含糊 | **4,378**；仓库为 `Tarquinen/opencode-dynamic-context-pruning`（`/repos/tarquinen/opencode-dcp` 返回 301 永久重定向） | 用实测值与解析后仓库名 |
| Anthropic 文档可达性 | 记录为"本网络区域封锁" | **本次可达**（`docs.anthropic.com` → `platform.claude.com` 301 后正常返回） | 已改为直引官方文档，最小可缓存长度按模型列出 |
| OpenAI 缓存粒度 | "1024-token increments" | 实为**最小前缀 1,024 token**（GPT-5.6+）；更早模型是**上报**粒度按 128 向下取整 | 已按官方原文修正表述 |
| residue 的缓存口径 | 记录为"无缓存策略" | 包为 `@serkanalgur/residue` 0.3.2，其仓库描述自称"injects via the context hook **with prompt-cache reuse**" | 已改为"自述有缓存考虑，但无机制展开"，标 INFERRED |
| Headroom | 仅作为"尾部追加 steering"技术出处 | 定位到 `headroomlabs-ai/headroom`（**76,252★**）与官方集成包 **`headroom-opencode` 0.41.0** | 已补充；这是一个前序 reconnaissance 未收录的实质参与者 |
| context-cache 包名 | `JackDrogon` / `@jimmyyen/...` 未定 | npm 上无 `opencode-context-cache`；实际为 **`@jimmyyen/opencode-context-cache` 1.1.1**，README 自述"Concept from JackDrogon/opencode-context-cache" | 已按实测包名引用 |

### 无法验证 / 明确缺口

- **Sleev**：`/search/repositories?q=sleev` 只返回 `CrackSleeve`、`PaddleSleeve`、`CacheSleeve` 等无关仓库，**无可解析的 GitHub 仓库**；npm 上亦无对应包。其架构与缓存策略**完全不可审计**（VERIFIED 为"不可解析"，非"不存在"）。
- **Gemini 显式缓存的 TTL 规则**：本网络可读的 caching 页面只给出隐式缓存的最小 token 数，明确将显式缓存指向 generateContent 页面并说明 Gemini 4 Argon 及以上不再支持显式缓存；**TTL 未取到官方原文**，故表中该格留空。
- **`opencode-cache-engine` 的 v2 管理式配置发现**：其 README 自述"implemented and offline-tested; isolated shim-based loading verified… but **managed-config discovery/registration remain unverified**"，且直接写 `plugins: ["opencode-cache-engine/v2"]` 在离线配置中未解析。该项目的 v2 能力按**自述 preview** 记录，未独立实测。
- **`residue` 的 prompt-cache reuse 机制**：仅有仓库描述的一句话，README 与 `package.json` 均未展开，且未见任何量化。标 **INFERRED（自述，未独立验证）**。
- **Magic Context 的 v2-capable 程度**：其 README 的技术描述主要围绕 OpenCode/Pi/OMP 多 harness 的 doctor 与配置流程，**未逐条列出 v2 hook 面**；本次记为"自述 v2-capable"，未独立实测。
- **`applyCachePolicy` 在插件 hook 之后运行**：该顺序来自前序 session 对宿主源码与探针的双向确认（见配套 `v2-032-respike.md`），本次**未重跑探针**；而 `applyCachePolicy` 本身签名、`BREAKPOINT_CAP = 4`、四断点位置、`RESPECTS_INLINE_HINTS` 白名单、Qwen/Gemini 特化均**于本次直读 `@opencode/ai@2.0.32` 包内代码确认**。顺序类结论按"前序 VERIFIED + 本次未复核"记录。
- **星标数**：全部为 2026-10-20 GitHub API 单次快照，不具备时间稳定性。