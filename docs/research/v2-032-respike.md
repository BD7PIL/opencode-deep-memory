# deep-memory 在 opencode 2.0.32 上的复测判决（E6 spike）

- **日期**：2026-10-20
- **被测对象**：`opencode-deep-memory` 0.15.1（分支 `feat/v2-032-adaptation` 起点 `87fdcc2`）
- **宿主**：opencode **2.0.32**（`@opencode/cli-linux-x64@2.0.32`）
- **隔离栈**：`/tmp/e6-lab`（`HOME` 隔离 + stub LLM :4311 + 引擎 :4399 + 项目 `/tmp/e6-lab/proj`）。生产 :4096/:4199 与既有 `opencode web` 进程零接触。
- **方法**：探针插件 `/tmp/e6-lab/probe/index.js` + 带前缀分析的 stub LLM `/tmp/e6-lab/stub-llm2.py`，逐面取证并回读 LLM 请求体（`/tmp/e6-lab/reqlog/{requests,analysis}.jsonl`）。
- **性质**：**推翻** E5 spike（`ocrc/docs/research/dm-v2-compat-verdict.md`，2026-10-15，宿主 2.0.27）的一项核心前提。E5 结论按 2.0.27 有效，但不再适用于 2.0.32。

## 0. 结论速览

| 项 | E5（2.0.27）判定 | E6（2.0.32）实测 | 影响 |
|---|---|---|---|
| `setup` 必须返回 disposer | 🔴 是 | 🟢 **是**（确认） | 不变 |
| ctx 无 `directory/serverUrl/client` | 🔴 是 | 🟢 **是**（26 面，仍无这三项） | 不变 |
| **`context` hook 不 await handler** | 🔴 **是**（"首个 await 之前的同步变更才生效"） | 🟢 **否——完全 await** | **warm-cache 磁盘交接整体作废** |
| system[] 变更是否序列化进请求 | 🟡 "不必然" | 🟢 **必然落地** | 注入可回到 system 通道 |
| 工具经 `tool.transform` 注册 | 🟢 路径成立 | 🟢 **成立**，但字段名/契约有变 | 需重写注册层 |
| `ctx.event.subscribe` | 🟢 "注册成功" | 🟢 **返回 AsyncIterable，事件真实到达** | 回调式注册是错的 |
| 事件名 `session.idle` / `session.compacted` | 未核 | 🔴 **v2 不存在这两个名字** | 必须做事件名归一 |
| `ctx.session.messages` | 🟡 走 HTTP 兜底 | 🔴 **不存在**；读取面是 `session.context` | 兜底路径重定向 |

## 1. 加载契约（P1）

`{ id, setup }` 形状在 2.0.32 上正常加载。`setup` 返回 disposer 正常被调用。

运行时 ctx 实测 **26 个面**（2.0.27 为 25，新增 `credential`）：

```
agent,aisdk,app,command,credential,event,experimental,generate,integration,location,
mcp,model,options,permission,plugin,provider,reference,rpc,session,shell,skill,storage,
tool,vcs,websearch,worktree
```

- `hasClient=false hasDirectory=false hasServerUrl=false` —— v1 三个输入字段在 2.0.32 上依然全部缺失。
- `location={"directory":"/tmp/e6-lab/proj","project":{"id":"global",...}}` —— `location.directory` 可用。
- `app={"name":"cli","version":"2.0.32","channel":"latest"}`。
- `session.keys=hook,create,get,remove,switchAgent,switchModel,prompt,generate,command,compact,synthetic,interrupt,update,move,wait,context`
  → **无 `messages`**。0.15.x 适配器 `buildV2Client` 的 `session.messages` 分支永久走空，只剩 HTTP 兜底。
- `tool.keys=reload,list,transform,hook`
- `event.keys=subscribe`（仅此一项）
- `storage.keys=get,set,remove,scan` —— 跨调用持久状态的**原生**通道（比 0.15.x 的磁盘 JSON 交接更合适）。

## 2. `context` hook 语义（P2/P3）——推翻 E5

探针在同一个 `context` handler 内放置四个互斥标记，并回读 LLM 请求体：

```
event.system.push(SYNC)                       // 立即，无 await
event.system.push(STABLE, cache:ephemeral)    // 立即
await new Promise(r => setTimeout(r, 40))     // 一个真实 await
event.system.push(ASYNC)                      // await 之后
lastUser.content.push(MSG)                    // 消息尾部
```

四个主请求（req01–req04）中 **四个标记全部 = 1**，无遗漏：

```
req01 sysHash=d94b74fee420e98d SYNC=1 ASYNC=1 STABLE=1 MSG=1
req02 sysHash=d94b74fee420e98d SYNC=1 ASYNC=1 STABLE=1 MSG=1
req03 sysHash=d94b74fee420e98d SYNC=1 ASYNC=1 STABLE=1 MSG=1
req04 sysHash=d94b74fee420e98d SYNC=1 ASYNC=1 STABLE=1 MSG=1
```

**判决：2.0.32 会 await `context` handler；handler 内的异步变更（含 await 之后）都会进入 LLM 请求，且 `event.system` 的追加会序列化进请求体。**

这条与上游源码一致（`packages/core/src/plugin/hooks.ts` 的 `trigger` 逐个 `yield* callback(event)` 顺序 await），也与官方迁移指南把 `experimental.chat.system.transform` / `experimental.chat.messages.transform` 双双指向 `session.hook("context")` 一致。E5 在 2.0.27 上观察到的"async 丢失"未能在 2.0.32 复现。

**连带事件形状**（P2 首次触发时 dump）：

```
context keys = sessionID, model, system, messages, options, agent, tools
system   = [{type:"text", text:"..."}, ...]   // 基础 4 段，SystemPart 形状
messages = [{id, role, content:[{type:"text",text}], metadata:{}}]
agent    = "build"
model    = {id:"stub-model", providerID:"e6stub"}     // 是 id，不是 modelID
options.keys = maxTokens
tools    = Record<name, {description, input}>          // 13 个，含插件注册的工具
```

**与 v1 的两处形状差异**：
1. 消息是 `{id, role, content, metadata}`，**不是** v1 的 `{info:{role}, parts}`。
2. `prompt` hook 的载荷是 `{sessionID, messageID, prompt, metadata, delivery}`，其中 **`agent` 与 `model` 均为 `undefined`**。v1 的 `chat.params`（记录 sessionID→agent/model）在 v2 只能映射到 **`context`**（`agent`/`model` 都在），不能映射到 `prompt`。

## 3. 工具注册与执行（P5/P6）

`ctx.tool.transform(o => o.add(...))` 在 2.0.32 上成立。编辑器面：`list,get,namespace,add,update,remove`。

**实测契约**：

| 字段 | 结论 |
|---|---|
| `name` | 必填。**最终 LLM 面名字 = `options.namespace` + `_` + `name`**：`name:"e6_hello"` + `namespace:"e6"` → 对 LLM 暴露为 **`e6_e6_hello`** |
| `description` | 直通 LLM |
| `input` | **JSON Schema**（对象形式 `{type:"object",properties:...}`）。注意字段名是 `input`，不是 v1 的 `args` |
| `output` | `{type:"object",properties:{output:{type:"string"}}}` |
| `options.namespace` | 必填，否则不进 LLM 面（E2 结论在 2.0.32 依然成立） |
| `execute` | **`async` 返回 Promise 在运行时可用**（类型上声明为 `Effect`，但运行时接受 Promise）。返回值 `{output: string}` 有效 |
| `transform` 回调 | 会被**多次调用**（观测到 2 次；reload 时重跑）。追加必须幂等，不能依赖闭包累积 |
| 可见性验证 | `tool.list` n=21 含 e6；`context.tools` 键含 `e6_e6_hello`；stub 请求 tools 数组含 `e6_e6_hello` |

**执行链证据（`execute.before` / `execute.after`）**：

```
P6 execute.before fired keys=tool,sessionID,agent,messageID,id,input
   tool=e6_e6_hello id=call_e6_hello_1 input={"x":"probe"} status=undefined
P5 e6_hello executed input={"x":"probe"}
P6 execute.after  fired keys=tool,sessionID,agent,messageID,id,input,status,result
   tool=e6_e6_hello status=completed result={"output":"E6-TOOL-OK {\"x\":\"probe\"}",
                                            "content":[{"type":"text","text":"..."}]}
```

- **合法 tool hook 名只有 `execute.before` / `execute.after`**。0.15.x 适配器用的 `ctx.tool.hook("*", ...)` 不是合法名，从未生效。
- `execute.after` 载荷与 v1 的 `(input, output)` 双参形状不同：v2 是**单对象**，且成功/失败用 `status` 区分（`completed` 带 `result`，`error` 带 `error`）。v1 handler 期望 `input.args` 与 `output.output`，桥接需映射。

## 4. 事件宇宙（P4）——v2 事件名与 v1 不同

`ctx.event.subscribe({signal})` **返回 AsyncIterable**（`isAsyncIterable=true`），55+ 事件真实到达。**回调式 `subscribe(fn)` 不会投递任何事件**（返回的 iterable 无人消费），0.15.x 适配器的写法因此是静默失效的。

2.0.32 上观测到的全部事件类型（`/tmp/e6-lab/probe/probe.log`）：

```
agent.updated  command.updated  integration.updated  model.updated  plugin.updated
provider.updated  reference.updated  skill.updated  vcs.branch.updated  websearch.updated
session.created  session.renamed  session.instructions.updated
session.inbox.enqueued  session.inbox.delivered
session.execution.started  session.execution.succeeded
session.compaction.started  session.compaction.delta
session.step.started  session.step.streamed  session.step.ended
session.text.started  session.text.delta  session.text.ended
session.tool.input.started  session.tool.input.ended  session.tool.called  session.tool.success
session.usage.updated
```

**关键负数结果**：`session.idle` 与 `session.compacted` **在 v2 中不存在**。0.15.x 适配器把 v1 `event` handler 原样接到 v2 订阅上，其 `switch (event.type)` 的 `session.idle` / `session.compacted` / `session.deleted` 分支在 v2 永不命中。因此 v2 下：

- idle 触发的记忆整理（主路径）——死
- compaction 压力校准 + 审计日志——死
- `session.deleted` 的 `forgetAgent` 清理——死

**需要的归一映射（v2 → v1）**：

| v1 事件 | v2 来源 | 依据 |
|---|---|---|
| `session.created` | `session.created`（同名） | 同名，data 含 `{sessionID, projectID, location, slug, version}` |
| `session.idle` | **`session.execution.succeeded`** | data=`{sessionID}`；每次执行结束触发一次（event#35/55 观测） |
| `session.compacted` | **`session.compaction.started`** | data=`{sessionID, reason, recent, inputID}`；另有 `session.compaction.delta` |
| `session.error` | `session.execution.failed`（未触发，按命名推断） | 同族命名 |
| `session.deleted` | `session.deleted`（未触发，未核） | 同族命名 |

`session.usage.updated`（data=`{sessionID, cost, tokens}`）是压力校准输入 token 的天然来源。

## 5. compaction（P7）

强制 `POST /api/session/{id}/compact`（需 JSON body，空 body 返回 400）后：

1. 事件：`session.compaction.started` → `session.compaction.delta`。
2. **`compaction` hook 正常触发**：

```
P7 compaction keys=sessionID,model,system,messages,options,agent,tools
   msgs=4 systemLen=4 agent="build" hasResult=false
```

- **`messages` 直接携带全量消息数组（4 条）** —— v2 的 compaction hook 不需要再去抓消息。0.15.x 适配器为此走了 `client.session.messages` + HTTP 兜底，在 v2 上完全没有必要。
- `systemLen=4` 是**基础段**，不含 `context` hook 追加的段（compaction 请求重新组装 system）。因此 v1 的 `output.context` 映射到 `event.system` 是必要且有效的。
- `agent="build"` 在 compaction 载荷里可用。
- 载荷**没有** v1 `output.prompt` 的对应物；v2 的 `SessionCompaction` 提供可写的 `result?: {summary,...}`，语义是"设置后跳过模型请求"，与"替换 compaction prompt"不同。0.15.x 丢弃 `out.prompt` 的行为在 v2 下没有直接替代品。

本轮的 `status:"failed"` / `"Compaction summary did not match the required template"` 是 **stub LLM 伪影**（stub 回复不匹配摘要模板），与 E1 记录的同类伪影一致；hook 链路本身正常。

## 6. 读取面（P8）

`ctx.session.messages` **不存在**。可用的读面：

- `GET /api/session/{id}/context` → `{data: [...]}`，消息 `type ∈ {user, assistant, idle, compaction}`：
  - `user` → `{id, time, text, type}`
  - `assistant` → `{id, time, type, agent, model, content, cost, tokens, finish, rawFinish, snapshot}`
  - `idle` → `{id, time, type, outcome}`
  - `compaction` → `{id, time, type, status, reason, error?, cost, tokens}`
- 池面另有 `session.get` / `session.context`（ctx 面）等。

对 deep-memory 的意义：idle 整理与 `context_compress` 子会话需要"取子会话最后一条 assistant 文本"，在 v2 应走 `session.context`（ctx 面）或该 HTTP 端点，并按上面 `type:"assistant"` / `content` 形状解析；0.15.x 的 `normalizeMessageList`（期望 `{id, role, content}`）解析不到 `type` 语义，需要重写。

## 7. 缓存实测

引擎的 token 账本含缓存位（`GET /api/session` 的 `tokens={input,output,reasoning,cache:{read,write}}`），但 stub LLM 不报缓存 token，故本轮 **`cache.read=0`，无法给出真实计费命中率**。因此以下用**前缀复用率**（相邻请求的最长公共前缀字符占比）作为可复现代理指标——provider 侧缓存按精确前缀匹配，前缀逐字节相同即可复用：

| 请求 | 工具数 | system 哈希 | system 字符 | 前缀复用率 |
|---|---|---|---|---|
| req00（标题生成，无工具、无插件注入） | 0 | `d2f45520a3d99f52` | 2119 | 0.000（冷） |
| req01（turn 1） | 13 | `d94b74fee420e98d` | 8285 | 0.000（冷） |
| req02（turn 2） | 13 | `d94b74fee420e98d` | 8285 | **0.994** |
| req03（turn 3） | 13 | `d94b74fee420e98d` | 8285 | **0.994** |
| req04（turn 4，工具调用后） | 13 | `d94b74fee420e98d` | 8285 | **0.988** |

结论：

1. **追加的 system 段是逐字节稳定的**（4 轮 system 哈希完全一致、字符数一致），证明"mtime 缓存 + 固定 TOOL_HINT"在 v2 下成立。
2. **前缀复用率 0.994**，即除首轮冷启动与当轮新增内容外，整段前缀可复用。
3. **工具定义逐字节稳定**（4 轮 tools 数组名与顺序完全一致），满足 v2 `applyCachePolicy` 的前置条件——工具在所有 section 之前，工具定义抖动会击穿其后的全部缓存。
4. req00（标题生成）无工具、无插件注入，说明 `context` hook 只作用于主请求（`kind="primary"`），不会污染标题等辅助请求——这对缓存是好事。

## 8. 对 0.15.x 适配器的判决

| # | 0.15.x 实现 | 2.0.32 实测 | 判决 |
|---|---|---|---|
| 1 | warm-cache 磁盘交接（`.v2-warm-cache.json` + `warmBySession` + `applyMessages`），理由是"context 不 await" | context **会** await，同步与 await 后变更都落地 | 🔴 **前提不成立，整体可删** |
| 2 | 注入走"最后一条 user 消息尾部" | system 追加可稳定序列化 | 🟡 可改回 system（见 §7：字节稳定的负载进 system 更优，易变负载留尾部） |
| 3 | `hooks["tool"]` 当函数调用 + 从未注册工具 | 需 `ctx.tool.transform(o.add)` + `options.namespace` | 🔴 **v2 下 7 个工具全部不可用** |
| 4 | `ctx.tool.hook("*", ...)` | 合法名只有 `execute.before/after` | 🔴 从未生效 |
| 5 | `ctx.event.subscribe(callback)` | 需 AsyncIterable 形态 | 🔴 事件全部丢失 |
| 6 | v1 `event` handler 原样接 v2 事件 | 事件名不同（无 `session.idle`/`session.compacted`） | 🔴 三个分支全部不命中 |
| 7 | `chat.params` 不桥接 | `context` 携带 `agent`/`model` | 🟡 可恢复（`bestModel()` 目前恒 undefined） |
| 8 | compaction 走 `client.session.messages` 抓消息 | compaction hook **直接给全量 messages** | 🟡 可简化，去掉抓取 |
| 9 | `normalizeMessageList` 期望 `{id, role, content}` | 读面消息带 `type` 语义（user/assistant/idle/compaction） | 🟡 需重写解析 |
| 10 | 消息形状 `{info, parts}` | v2 是 `{id, role, content, metadata}` | 🟡 桥接需双向映射 |

## 9. 遗留项（非阻塞，供后续批次）

1. `session.error` → `session.execution.failed` 与 `session.deleted` 的实际命名未触发核验（本轮只跑了成功路径）。
2. compaction 的 `result.summary` 直写（跳过模型请求）是一条未采用的路径；语义与 v1 的 `output.prompt` 替换不同，需要设计决策。
3. 真实计费命中率需要真 provider（本轮只能给前缀复用率）。
4. `session.compaction.delta` 之后的完成事件未观测到（本轮 compaction 因 stub 模板校验失败而中止）；正常路径下应存在 `session.compaction.ended` 或等价物，需在真实 provider 下复测。
5. EL7/glibc 约束：2.0.32 二进制最高需要 `GLIBC_2.17`，本机 2.17，可运行（实测 `--version` 与 serve 均正常）。

## 10. 复现现场

- 隔离栈：`/tmp/e6-lab/`
  - `start-e6.sh`（HOME 隔离、`OPENCODE_SERVER_PORT=4399`、`OPENCODE_SERVER_PASSWORD=e6lab-fixed-password`）
  - `stub-llm2.py`（带工具名发现 + 前缀分析的 stub，:4311）
  - `probe/index.js` + `probe/package.json`（探针插件，日志 `/tmp/e6-lab/probe/probe.log`）
  - `drive-e6.sh`（一键驱动：加载 → 3 轮 → 工具调用 → 强制 compaction）
  - `reqlog/requests.jsonl`（完整请求体）、`reqlog/analysis.jsonl`（逐请求缓存分析）
  - `home/.config/opencode/opencode.json`（`plugins: ["/tmp/e6-lab/probe"]`）
- 二进制：`/tmp/e6-lab/bin/opencode`（2.0.32）；类型包：`plugin-pkg/`、`schema-pkg/`、`ai-pkg/`、`client-pkg/`