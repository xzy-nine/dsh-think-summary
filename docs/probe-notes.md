# probe-notes.md — 运行时探测结论

探测方式：会话内动态 Cordis 插件（thkp-1）包住 `llm/stream` 与 `session/event`，
采集真实 DeepSeek 流（deepseek-official / deepseek-v4-flash）与真实会话事件。
本文是 M1 探测的权威结论，代码里的分类器/归属/过滤必须与此一致。

## M2 验证补充（动态原型 + 合成测试）

- **实机**：修复后管线对真实流行为正确——短流（<2000 tok）不产出任何段
  （阈值门控 + flush 下限生效）；`reasoning→text/tool-call` 块切换信号被捕获。
- **重要发现：子代理的思考流对主进程 `llm/stream` 不可见**（子代理独立上下文，
  其 `llm/stream` 不在主进程事件流中）——验证了"旁路流过滤"的必要性，
  也说明该插件只会处理当前主会话的思考链。
- **合成**（确定性，本地跑）：
  - 结构词/代码围栏边界 → 多段正确（1681 + 1379 tok）；
  - 无边界超长单行 → hardMax + flush 有界切分（5335 + 970 tok）；
  - 短思考（<64 tok 尾巴）→ 0 段。
- **审查驱动的修复**（独立子代理 code review）：锚定行首的结构词正则、
  只测尾部/当前行的边界检测（避免陈旧信号）、静态路径超长行按句号拆分子行、
  检测器原始计数（消除逐增量取整低估）、state 级段哈希去重、try/finally
  flush、兜底按 turn+step 缓冲并追加、客户端常驻慢轮询。

## M3 验证补充（精炼管线实机探测）

精炼调用（`llm.stream`）契约——实测确认：
1. **`messages[].content` 必须是内容块** `[{ type: 'text', text }]`；纯字符串 content
   直接失败（`finish{reason:{kind:'failure'}}`）。
2. **`system` 走顶层字段**（与主流 GenerateOptions 一致）。
3. **该 provider 不支持 `reasoningEffort`**（设置报 `UNSUPPORTED_REASONING_EFFORT`）。
4. **模型总是先推理**：`maxTokens` 必须覆盖推理+答案；预算不足卡在
   `finish{kind:'max-tokens'}` 不出答案。实测 256 卡死、1024 正常。
5. 实测单次精炼：**input 777 + output 67（含 reasoning 40）≈ 0.85k token，~1.4s**，
   答案 43 字符中文摘要；`finish{kind:'stop'}`。
6. `llm.listModels('deepseek-official')` 返回 `deepseek-v4-flash`/`deepseek-v4-pro`
   （无 contextWindow 字段，auto 解析按目录顺序取第一个）。
7. 错误隔离：坏 provider 不抛异常（终态 error chunk），队列吞掉即可。

### 0.1.5-rc.2 复核（供应商目录与设置服务）

8. `llm.listProviders()` 返回**已注册** provider 路由（`{ id, name }`，
   `listConfigurableProviders()` 另列声明但未激活者）；本机实测
   `[{ id: 'deepseek-official', name: 'DeepSeek' }]`，`/api/think-summary/models`
   即以此为“可手动选择的其他供应商”列表。
9. 跨供应商精炼：`llm.stream({ provider, model, ... })` 的 provider 由选项决定，
   与主请求 provider 无关；精炼调用不带 `sessionId`/`purpose`，因此不会被本插件的
   旁路流过滤（`filterNonAgentLoop`）二次接管。
10. `settingsController.describe()` 返回**全部已注册命名空间**（不再有第三方
    白名单），设置卡片因此能在“设置 → 插件配置”中被派发；`settings` 服务的
    `installSection(owner, ns, schema, entry, hooks)` 是方法而非顶层导出，且
    `@deepseek-ai/dsh-settings` 不再导出 `installSettingsSection` /
    `settingsNamespace`——外部插件改经 `ctx.get('settings')` 调用。
11. **provider 侧失败不抛异常**：适配器/鉴权/HTTP 失败以终态 chunk
    `finish{reason:{kind:'error'|'aborted', failure:{code,status,message}}}` 收尾
    （实测 ollama baseURL 写成 `/api/chat` 时 404 即此形态）。只累计 `text-delta`
    会把这类失败静默吞掉——段永远停在“待精炼”。精炼必须检查终态 chunk。
12. **补丁热重载不重新 import Host 模块**：改 `profiles/web/cordis.patch.yml`
    会重载插件行（进程内状态重建），但 `lib/*.js` 仍命中 ESM 缓存——实测加构建标记
    后 `/api/think-summary/state` 仍返回旧值。**Host 代码改动必须重启 dsh web**；
    只有 `lib/client.js` 由浏览器侧重新拉取。
13. 小模型先推理且推理量很大（`qwen3.5:4b` 单次精炼实测 370 个 reasoning-delta、
    15 个 text-delta；512 token 预算够用，1024 更稳）；预算耗尽时是
    `finish{kind:'max-tokens'}` 且**无任何 text-delta**，需按“无文本”单独上报。
14. **关思考只能由 provider 侧决定**（实测，Ollama `qwen3.5:4b`）：

    | 手段 | 结果 |
    |---|---|
    | `llm.stream` 不带 `reasoningEffort`，provider 未声明档位 | 思考 11479 字符，35.2s |
    | `/v1/chat/completions` 带 `reasoning_effort: "none"` | **思考 0，0.39s** |
    | `enable_thinking: false` | 被 Ollama 忽略，31.7s |
    | `think: false` 打到 `/v1` | 被忽略（那是 `/api/chat` 原生端字段），21.8s |
    | 提示词加 `/no_think` | 1118 → 794 个 reasoning 增量，未真正关闭 |

    `reasoningEffort` 走不通的原因：`resolveCallConfig` 对未声明档位的路由直接拒绝
    （`does not support reasoning effort "none"`）。正解是 provider 声明
    `compat.supportsReasoningEffort: true` + 模型 `reasoningEfforts: { off: none, ... }`；
    pi-ai 的 openai 分支把 `levels.off` 的线格式写进 `params.reasoning_effort`，
    于是**不传 effort 的调用（插件精炼）默认即 `none`**，单次精炼从 >60s 超时降到 ~7s。

## 1. StreamChunk 形状（llm/stream 产出）

流是**块结构**：`block-start` → N 个 delta → `block-end`，结尾 `usage` + `finish`。

| chunk.type | 字段 | 说明 |
|---|---|---|
| `block-start` | `type, index, blockType` | 声明一个内容块开始；`blockType` 实测取值：`reasoning` / `text` / `tool-call` |
| `reasoning-delta` | `type, index, text` | **思考文本增量**（本插件核心数据） |
| `text-delta` | `type, index, text` | 正式回复文本增量 |
| `tool-call-delta` | `type, index, ...` | 工具调用增量 |
| `block-end` | `type, index` | 关闭一个块 |
| `usage` | `type, usage: <obj>` | 用量统计（终态前） |
| `finish` | `type, reason: <obj>` | 终态 |

- `index` = **块序号**（同一请求内 reasoning 块为 0、text 块为 1、tool-call 块递增），
  不是 chunk 序号；`reasoning-delta` 的 `index` 恒为所属块序号。
- 长思考时 `reasoning-delta` 是绝对主力（单次调用 399+ 个）。
- 块边界：`block-start {blockType}` → deltas → `block-end`；`blockType` 从
  `reasoning` 切到 `tool-call`/`text` 就是"思考段结束"的强信号（M2 语义边界用）。

## 2. GenerateOptions（llm/stream 请求）

顶层键：`provider, model, reasoningEffort, maxTokens, messages, system, tools, sessionId, signal`

- **`sessionId` 直接在请求上** —— 会话归属首选此字段，无需绕 initiator。
- `reasoningEffort` 存在（未来可读思考档位）。
- 未发现名为 `markAgentLoopRequest` 的属性键；agent-loop 标记可能是 symbol 或
  未出现在本窗口（旁路流过滤策略见 §4）。

## 3. 会话归属（流 → sessionId）

- `agents.currentInitiator()` 在流开始与流中（第 100 chunk）**均可用**，
  返回当前 Agent 的 sessionId。双保险：`options.sessionId` + initiator。

## 4. 会话事件（session/event，事后兜底用）

事件类型（实测窗口）：`assistant/chunk`、`assistant/message`、`step/start`、
`step/end`、`request/header`、`tool/call`、`tool/result`。

- **`assistant/chunk`**：`data = { turn, step, chunk }`，其中 `chunk` 就是**原始
  StreamChunk**（同一形状）。兜底路径可直接按 `reasoning-delta` 重建思考全文。
- **`assistant/message`**：最终消息事件，`data = { turn, step, message, usage }`；
  `data.message.content` 为内容块数组，块类型实测：**`reasoning` / `text` /
  `tool-call`** —— 日志里 thinking 块名 = `reasoning`（兜底也可直接取该块的完整文本）。

## 5. 对实现的修正（与 design.md 初稿的差异）

1. 分类器：thinking 判定 = `chunk.type === 'reasoning-delta'`，取 `chunk.text`（初稿写 `thinking`，错）。
2. 归属：优先 `options.sessionId`（请求上直接有），`agents.currentInitiator()` 兜底（实测流中可用）。
3. 语义边界信号可增强：`block-start` 的 `blockType` 变化（reasoning → tool_call/text）
   就是"思考段结束"的强信号；`block-end` 也可作为块边界参考。
4. 事后兜底：`assistant/chunk` 事件流与实时流同构，可无损重建思考文本。

## 6. M4 部署验证（实机）

1. **安装**：`dsh plugin --profile web add link:<repo>` 成功（profile package.json
   的 dependencies + dsh.profile.bundles 自动接线；node_modules 符号链接）。
2. **Host 半面正常**：`settings.describe()` 含 `think-summary` 命名空间，
   `settings.get('think-summary')` 返回完整默认配置。
3. **设置卡片"Host 未暴露该命名空间"根因**：dsh-host-apiproxy 只把白名单命名空间
   （`WEB_SETTINGS_NAMESPACES` = agent-loop/shell/locale/permission/ui-conversation/
   ui-theme/web-search-deepseek + 模型 provider + ui-onboarding/agent-default-model）
   服务给浏览器；第三方命名空间被 `settings-not-exposed` 拒绝（官方注释：迁移到
   `settings.register()` 暴露是待办工作）。web-ui 组的桥接（`/api/dsh-web-ui-settings`）
   也**只认家族清单**（`FAMILY_NAMESPACES` + `NAMESPACE_ALIASES`，think-summary 解析
   为 undefined）。**最终解法**：自建 loopback 设置桥
   （`/api/think-summary/settings/describe|mutate`，宿主直连 settings 服务，
   revision 围栏）+ 客户端迷你 scope 控制器，不依赖任何白名单。
4. **webServer 路由 404 根因**：插件 apply 时 webServer 服务尚未挂载（bundle 加载
   顺序），`ctx.get('webServer')` 返回 undefined 被跳过。**解法**：响应式注册
   （监听 `internal/service` 在 webServer 出现时补注册）。
5. **客户端 bundle 实时读取**：`/plugins/<包名>/client.js` 每请求读取 lib/client.js，
   改客户端代码后刷新浏览器即生效，无需重启；Host 半面改动需重启 dsh。

## 7. 客户端槽位（0.1.5 实机踩坑）

1. **apply 期间什么都不能等**。客户端插件 `apply` 跑在官方条目注册**之前**
   （`slots.entries('…')` 返回 0 条），`timer` 服务还没挂载，浏览器全局定时器也不可用。
   所以：先同步试一次；不成就往同一个槽位注册一个**渲染 null 的注册器组件**，
   在它的 `React.useEffect` 里用 `setInterval` 轮询，拿到官方条目后完成接管。
2. **优先级规则（keyed 和 list 槽位同一条）**：同一个 key/id 用**相同 priority**
   再注册会被直接拒绝，报错原文要求换优先级：
   `… already has an entry with id "todo" at priority 0 (registered by …) —
   register at a different priority to shadow it (lowest renders)`。
   **越低越先渲染**，接管官方条目用 `priority: -1000`（步骤卡 `assistant-step`、
   看板 `todo` 都是这么接管的），并且注册时**保留官方的 `locale`**，否则拿不到 `t`。
3. **委托渲染**：`slots.entries(name)` 能拿到官方的 `component` 与 `locale`；
   以更低优先级重注册后，组件里 `React.createElement(official, props)` 原样委托。
   接管成功后官方条目**仍留在 `entries()` 里**（只是 `active: false`），委托路径因此一直有效。
4. **注册要 try/catch 兜住**：注册抛异常会把整个注册器条目打成失效，并连带该步之后
   的步骤（样式注入等）不再执行——`index.js` 里每一步都单独包了 `step(label, run)`。
5. **会话格式 v3：`assistant/chunk` 事件已不存在**。实时思考改从
   `assistant/message.data.stream` 读 reasoning 增量；兜底路径读
   `data.message.content` 里的 `reasoning` 块；`data.message.id` 可作匹配键
   （比 `turn+step` 更稳）。
6. **看板中文补充只改渲染**：委托官方 `TodoDock`，只把传进去的 `props.useProjection`
   包一层，让 `'todos'` 返回 `原文（中文）`；**不写 `session.append`**，
   因此模型后续读到的计划仍是原文，不受影响。
   翻译由看板下方的**按钮手动触发**（`POST /api/think-summary/todo-translate`）：
   宿主不监听 `todo/write`、不判断哪些条目该翻，请求里给哪几条就翻哪几条，
   结果按 `原文 → 中文` 内容缓存（与会话无关，重复点击不再调模型）。
7. **`fetch` 的可用性分两种**：动态 Cordis 插件沙箱里没有 `fetch`（只能走 Host RPC）；
   而安装版客户端 bundle（`/plugins/<包>/client.js`）是普通浏览器环境，`fetch` 正常可用。
8. **把手动按钮做进官方卡片里**：官方 `TodoDock` 不能接收 children，所以外层套一个
   `.ts-todo-wrap`（复刻官方 `.root` 的宽度公式/圆角/边框/底色）画卡框，再用
   `.ts-todo-wrap > section`（官方根节点是 `<section data-testid="todo-panel">`，
   这是唯一的非 hash 选择器钩子）把官方面板自己的边框/圆角/底色去掉，按钮作为
   页脚行贴底 → 视觉上是同一张卡片。官方渲染 `null`（无待办）时不要输出外层 div，
   否则会留一个空卡框。

## 8. 换供应商就总结不了 / 关思考没反应（0.1.5 实测）

两条都被误判成"插件自己拼 curl"，实际都走 dsh 的 `llm` 服务（报错全是 pi-ai 的
`PI_AI_ERROR`/`INVALID_REQUEST`）。证据来自 `~/.dsh/dsh-think-summary.json`
的 `unrefinedReason` 历史（111 条）与直连供应商的对照实测。

### 8.1 `max_tokens` 原样透传 → 供应商 400

```
st/deepseek-v4-flash        400  field MaxTokens invalid, should be in [1, 384000]
st/sensenova-6.8-flash-lite 400  field MaxTokens invalid, should be in [1, 65536]
```

插件把设置里的 `refineOutputTokens` **直接**当 `maxTokens` 发给 `llm.stream`，
而该值被设成了 `9999999`。**主链路不会这样**：它只在 `agent-loop.maxTokens`
显式配置时才发 `maxTokens`（`packages/core/agent-loop/src/agent.ts`），
否则省略，让适配器按目录处理。

修法：`resolveOutputCap()` 读 `llm.resolveModelInfo().defaultMaxTokens`
（= 供应商块里写了 `maxTokens` 才有，是 harness 为**部署选择的每请求上限**），
只在**上限已知**时把预算收敛到上限内；上限未知则**保留原值**不猜测
——强压到猜出来的数字会让今天能用的路由（如 buddy）因预算耗尽而失败，与本次的 bug 同类。

要点：**不能拿 `context.contextWindow` 当输出上限**——那是输入上下文容量。
实测 `st/deepseek-v4-flash` contextWindow 1048576 而 `max_tokens` 上限 65536。

### 8.2 关思考：`off` 在没声明的供应商上等于没关

pi-ai 的 `describableReasoningLevel` 注释写明：`off` 会被翻译成**省略 reasoning
字段**，对该模型与"不传 effort"字节级等价——**供应商自己默认思考时，选 `off` 依旧思考**。
所以"关思考没用"不是插件 bug，而是该供应商/模型**没有声明可关的档位**。

修法：新增 `refineDisableReasoning`（默认开），但**只在该模型确实声明了 `off` 档位时
才发送** `reasoningEffort: 'off'`（`canDisableReasoning()` 查 `resolveModelInfo().reasoning.efforts`）。
无条件发送会抛 `UNSUPPORTED_REASONING_EFFORT`，把本来可用的路由打挂
（`packages/llm/llm/src/index.ts` 的 `resolveCallWithInfo`）。

### 8.3 商汤（`st`）实测结论

直连 `https://token.sensenova.cn/v1` 得到的事实（**不是猜的**）：

| 事项 | 实测 |
|---|---|
| `/v1/models` | 200，每模型带 `max_output_length`、`output_modalities`、`supported_features` |
| `reasoning_effort` 取值 | 只接受 `low/medium/high/xhigh/**none**`；`off`、`minimal` → **400** `field ReasoningEffort invalid` |
| 关思考效果 | `reasoning_effort: none` → `reasoning_content` 长度 69 → **0**（真关掉） |
| `sensenova-6.7-flash-lite` | **404 `model route not found`**（列表里有它，chat 打不通；疑似账号 SKU/额度） |
| `sensenova-u1-fast` / `u1.5-lite` | **404 `model is not found`**：`output_modalities` 只有 `image`（信息图生成专用，无 chat 路由） |
| 可用 chat 路由 | `deepseek-v4-flash`、`glm-5.2`、`sensenova-6.8-flash-lite`、`deepseek-v4-pro`、`kimi-k3` |

因此 `settings.yaml` 的 `st` 块：加 `compat.supportsReasoningEffort: true` +
每模型 `reasoningEfforts: { off: none, low/low, medium/medium, high/high }`
（`off` 映射到商汤认的 `none`——这正是 pi-ai 里 `reasoningEfforts.off` 的用途），
按 `max_output_length` 补 `maxTokens`，并移除两个无 chat 路由的 u1 模型。

已用仓库自身的 `resolveRouteModels` + `getSupportedThinkingLevels` 验证该 profile
解析无误、`configuredMaxTokens` 恰为声明值、6 个模型都含 `off` 档位。

### 8.4 免费模型不让并发 → `RATE_LIMIT 429 rpm exhausted`

商汤免费额度是**按分钟限流**的：并发 2 以上就 `429 code=8 rpm exhausted`。
把设置里的「并发」调到 **1** 即可（`refineConcurrency: 1`）。

注意插件里有**两个会打供应商的地方**：精炼队列（受 `refineConcurrency` 约束）
与任务看板翻译（`todo.ts` 直接 `llm.stream`，**不经过并发队列**）。
所以看板翻译与精炼同刻发生时会突破并发 1 —— 免费额度下这是 429 的来源之一。

### 8.5 错误码直显（不必再翻日志）

失败原因串本来就带码，只是被长 JSON 淹没、且只藏在 hover tooltip 里。
现在 `errCodeOf()` 抽出短码直显：

| 界面位置 | 显示 |
|---|---|
| 步骤卡失败行行尾 | 小徽章：`RATE_LIMIT 429` / `INVALID_REQUEST 400` / `UNKNOWN_MODEL` |
| 整体摘要失败 | `整体摘要失败 · RATE_LIMIT 429` |
| 视图页 / 面板段状态 | 徽章显示短码（原来是整句长文本） |
| 看板「翻译为中文」按钮 | `翻译失败，点击重试 · RATE_LIMIT 429` |

完整原因始终挂在 `title`（悬停可看）；抽不到码时不造假码、退回原文单行截断。
宿主侧的任务翻译也改为把 `error` 回传界面（此前只 `console.error`，界面永远只说"失败"）。

### 8.6 单模型 → 模型池（多模型轮转 / 每模型并发 / 指数退避）

§8.4 的结论（"把并发调到 1"）只是止血：单模型被限流时整条精炼链路都停摆。
改成**模型池**（`src/host/pool.ts`）后：

| 机制 | 实现 | 解决什么 |
|---|---|---|
| 轮转 | `ModelPool.pick()` 从游标起找第一个"未退避且未满载"的，命中即推进游标 | 不盯着一个模型薅，多个免费模型轮流用 |
| 每模型并发 | 每个 `PoolEntry` 各自 `inFlight`；总并发 = 模型数 × `poolPerModelConcurrency` | 不再"对一个模型并发"，多模型时总吞吐随模型数放大 |
| 指数退避 | 失败后 `blockedUntil = now + base*2^(n-1)`（2s→4s→…→60s），成功清零 | 被限流的模型自动让位，其他模型顶上 |
| 换模型重试 | 一个任务最多 `poolMaxAttempts` 轮，每轮重新 `pick()`；全失败才写回错误 | 单次失败不再"永久停在未精炼" |

**关键设计点：精炼与任务翻译必须共用同一个池子**（`ModelPoolManager` 在
`index.ts` 注入 `RefineQueue.usePool()` 与 `createTodoTranslator()`）。
否则看板翻译会绕过精炼的退避继续打同一个模型——§8.4 里那个"两个调用点"的
隐患正是这么来的。

重投必须**有界**：任务在模型退避时会被放回队列等待，若不加 `attempts` 上限，
一个恒定失败的任务（例如提示词本身有问题）会无限重投。现在
`totalBudget = poolMaxAttempts * 3` 兜底。

配置形状取舍：设置页存的是 **`"provider/model"` 字符串数组**（`refineModels`），
因为设置桥是逐字段 `set`，直接存 JSON 值最省事；气泡显示时只取斜杠后的模型名，
完整值放 `title` 悬停。池子为空则回退原来的 `refineProvider`/`refineModel` 单模型路径。

### 8.7 自动开关思考重试（避免"关不掉思考"死局）

§8.2 的结论是"模型没声明 `off` 档位就别发 `reasoningEffort`"。但这样一来
**能关的关了、不能关的没关**，用户没法统一配置。改成**自动开关**：

- 同一模型的**第 1 次尝试不带** `reasoningEffort`（先按供应商默认跑）；
- 失败后**第 2 次尝试带上**（`shouldDisableReasoning(disable, attempt>0)`）——
  "没关思考导致预算被推理烧光"的模型因此能自己救回来；
- 仍叠加 `canDisableReasoning` 兜底：模型没声明 off 档位时**绝不发送**
  （llm 对未声明档位直接抛错，发了会把可用路由打挂）。

注意：该模型第二次尝试**不写失败统计**——那是"自动开关"的一次拨动，不是模型不可用，
否则气泡状态色会把可用模型误判成红。

### 8.8 气泡状态色（跨进程持久化）

`~/.dsh/dsh-think-summary-pool.json`（与思考总结分开，原子写）累计每个模型的
`{ok, fail}`，设置页气泡按成功率上色：

| 档位 | 条件 | 显示 |
|---|---|---|
| 绿 | 成功率 ≥50% | 绿点 + 绿边框 |
| 黄 | <50% 但成功过 | 黄点 + 黄边框 |
| 红 | 一次都没成功过 | 红点 + 红边框（气泡降透明度） |
| 不显示 | 总尝试 <5 次 | 空心灰点 |

**必须跨进程累计**：单次运行内样本太少，"一次没成功过"重启就清零的话永远显示不出红/绿。
写盘合并到 1s 一次（一个思考几十段，逐次同步写会拖慢精炼）。

### 8.9 逐个实测筛掉不可用模型

`/v1/models` **会列出实际打不通的模型**——本次踩到两次
（商汤 `sensenova-6.7-flash-lite`、NVIDIA `nemotron-70b` 都在目录里但 chat 404）。
所以筛模型必须**逐个发真实 chat 请求**：

| 模型 | 实测 |
|---|---|
| `nvidia/nvidia/llama-3.1-nemotron-70b-instruct` | chat **404**（历史失败记录里 56 次） |
| `nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1` | chat **404** |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | 挂死无响应（HTTP 000） |
| `nvidia/meta/llama-3.2-90b-vision-instruct` | 挂死无响应 |
| `nvidia/poolside/laguna-xs-2.1` | **503** ResourceExhausted（长期排队） |
| `meta/llama-3.2-11b-vision-instruct` / `90b` | 视觉模型，做文本摘要不合适 |
| 其余 8 个（商汤 2 + NVIDIA 6） | 200，保留 |

池子从 14 个精简到 **8 个**（全是实测可用的）。

### 8.10 整体摘要漏接池子（补）

§8.6 只把池子接进了段精炼（`runOne`），**第二遍整体摘要 `runThink` 仍走
`resolveRefineRoute` 单模型路径**——症状是：池子里的模型限流时整体摘要单独失败，
且它不参与状态色统计（气泡颜色只反映段精炼）。

修法：把池子取用逻辑抽成 **`attemptViaPool` 公共引擎**（轮转 / 每模型并发 /
指数退避 / 自动开关思考 / 有界重投），段精炼与整体摘要各传自己的 `run` 回调：

```
runViaPool → attemptViaPool(run: runRefine,       requeue: () => this.queue)
runThink   → attemptViaPool(run: runThinkRefine,  requeue: () => this.thinkQueue)
```

两处都保留"池子为空 → 回退单模型"的分支，所以没配池子的用户行为不变。

**回归测试要点**：直接断言整体摘要的请求落在**池内模型**（注入只含 `st/a` 的池子，
断言 `llm.stream` 收到的 provider/model 是 `st/a`，而不是配置里的 `ollama`）。
只断言"代码能编译/函数被调用"抓不到这种漏接——这正是它此前没被发现的原因。

### 8.11 「自动开关思考」必须记住结论（否则每任务都白烧一遍）

§8.7 的自动开关只按**本次任务的 attempt 序号**判断（`attempt > 0` 才带
`reasoningEffort`），没有任何跨任务的记忆。后果实测很严重：

```
nvidia/nemotron-3-super-120b   不带 effort: 24.6s    带 effort=none: 1.0s
nvidia/openai/gpt-oss-20b      不带 effort: 15.9s    带 effort=none: 0.9s
```

差 **16~25 倍**。而池子 8 个模型里 **6 个 `reasoning: true`**（默认会思考），
于是每个新任务都先跑一次 15~25s 的慢请求，失败后才带 `reasoningEffort` 重试——
这就是"多模型反而比单模型慢"的主因（单模型时代直接发 `off`，没有这段开销）。

修法：把结论**持久化记住**（写进 pool-stats 的 `reasoning` 字段）：

| 学到的情况 | 结论 | 之后的行为 |
|---|---|---|
| 带 `reasoningEffort` 成功过 | `'off'` | 每次都带（快路径，不再试错） |
| 带 `reasoningEffort` 被明确拒绝（400/UNSUPPORTED） | `'on'` | 永不带 |
| 无记录 / 老版本文件 | `'undecided'` | 首次不带、失败后带（探测一次） |

**每个模型只交一次学费**。这同时自动修掉了 `openai/gpt-oss-20b` 的矛盾
（它声明了 `off` 档位，但实测发 `none` 会 400）——不用手配，试一次就会被记成 `'on'`。

### 8.12 低成功率模型降频（成功也不能清零冷却）

原退避只看**连续失败**（`blockedUntil`），一旦成功就 `failures = 0`、
退避解除。于是 26% 成功率的 `st/deepseek-v4-flash` 被同等频繁地轮转到——
它每次成功都抹掉失败计数，永远得不到"少叫我"的待遇。

修法：新增独立的 `cooldownUntil`，只按**累计成功率**算，成功也**不清零**：

```
成功率 ≥50%  → 不冷却（0）
成功率 <50%  → 冷却 = 30s × (1 + 失败率)，封顶 300s
              50% → 30s；26% → 52s；一次没成功过 → 60s
```

这样低效模型仍会被用到（不至于饿死），但调用频率被压下来，把机会让给高成功率模型。
冷却与退避相互独立：`pick()` 要求两者都到期；`nextWakeMs()` 取二者较大值安排唤醒。

### 8.13 整体摘要改在「思维链结束」时汇总一次

原实现是**每段精炼成功就触发整体摘要**（`index.ts` 的精炼回调里调 `scheduleThink`），
只靠 `THINK_DEBOUNCE_MS = 1200` 防抖。但段与段的间隔通常远超 1.2s，防抖形同虚设——
一次 N 段的思考会打 **N 次**整体摘要，等于"总总结次数 = 段数"（用户明确否掉）。

修法：把触发点换成**思维链真正结束**这一权威信号：

- `stream.ts` 在 `finish`（及 `finally` 兜底）时调 `store.endThink()`；
- `endThink` 只在**由活跃转为结束**时通知 `onThinkEnd` 订阅者一次
  （幂等：finish 与 finally 双调用不会重复触发整体摘要）；
- `index.ts` 订阅它 → `scheduleThink()`，全程**只汇总一次**。

两个配套细节：

1. **等最后几段精炼落定**：思维链结束时最后一段可能还在精炼。新增
   `RefineQueue.hasPendingFor(sessionId, thinkId)`，若仍有在途任务则延迟重试
   （700ms × 最多 6 次），避免用"启发式摘要"顶替刚精炼好的结果。
2. **`thinkDone` 一次性守卫**：兜底路径的 think 生来 `active = false`（没有结束事件），
   仍在精炼回调里触发；守卫保证它同样只汇总一次。

**测试要点**：`endThink` 幂等（双调用只通知一次）、未知会话不通知、
订阅者抛错不影响收尾、`hasPendingFor` 的在途语义。
