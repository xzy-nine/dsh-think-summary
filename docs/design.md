# dsh-think-summary 设计文档

思考链分段总结插件 —— 检测模型的**长思考链**，在思考进行中按段产出摘要，实时展示在聊天区，且**全程零侵入主请求、不污染会话上下文**。

- 目标平台：DSH（Cordis 架构）
- 发布形态：独立仓库包（standalone Cordis plugin，可发布 npm / 本地安装）
- 版本：v0.1 设计稿

---

## 1. 目标与非目标

### 目标
1. **检测**：识别"过长"的思考链（以 thinking token 数为度量）。
2. **分段**：思考进行中，把思考流切成有语义的段。
3. **总结**：每段即时产出摘要；优先零成本启发式，按需用小模型精炼。
4. **展示**：思考进行中，在聊天区实时面板滚动显示各段摘要。
5. **省 token**：检测与分段 0 token；总结默认 0 token，精炼受严格成本控制。

### 非目标（v1 明确不做）
- 不把总结写回会话上下文（用户已确认：仅 UI 展示）。
- 不替换官方思考链渲染器（`assistant-step` 槽位是官方 UI，替换风险高）。
- 不做"思考死循环检测"（可作后续扩展）。
- 不修改/限制模型的 reasoning effort（v1 只观察；`agent/request` 瀑布留作扩展点）。

---

## 2. 总体架构

```
                        ┌──────────────────── Host ────────────────────┐
                        │                                              │
   模型 provider ──► llm/stream 瀑布 ──► 检测模块 ──► 分段模块 ──► 总结模块
   (每次流式调用)      (包一层,只观察)   (thinking    (双阈值+语义  (启发式即时
    retry/replay 也走    chunk 分类)      token 计数)  边界,缓冲)    + 小模型精炼)
                        │                      │                        │
                        │                 state 存储 (sessionId+turn)   │
                        │                      │                        │
                        │        harness.handle('think-summary/state')   │
                        └──────────────────────┼────────────────────────┘
                                               │ host.call 轮询 (~1.5s)
                        ┌──────────────────────┼────────────────────────┐
                        │                   Client                       │
                        │  conversation.input.dock 槽位 ──► 摘要列表面板   │
                        └───────────────────────────────────────────────┘

兜底路径（事后）: session/event 提交后，读 thinking 内容块，对整链补跑分段+总结
```

**两条路径**：
- **实时主路径**：`llm/stream` 瀑布（Host）——包住 `AsyncIterable<StreamChunk>`，逐块观察，边思考边分段边总结。
- **事后兜底路径**：`session/event`（Host）——消息落库后核对，若实时路径漏了（断流、异常、被过滤）则补跑。

**通信**：动态插件 RPC 是 Client→Host 单向，v1 用轮询（`host.call` 拉取状态，纯本地 JSON、零 LLM token）。

---

## 3. 关键钩子（已通过 Inspect 确认）

| 钩子 | 类型 | 用途 |
|---|---|---|
| `llm/stream`（Host 事件） | waterfall，`(options, next) => AsyncIterable<StreamChunk>` | 实时主路径：包流、观察 thinking chunk |
| `session/event`（Host 事件） | emit，`(session, event)` | 事后兜底：读 thinking 内容块 |
| `conversation.input.dock`（Client 槽位） | list，session 作用域，composer 上方整行 | 实时摘要面板 |
| `harness.handle` / `host.call` | 包私有 RPC | Client 轮询状态 |
| `settings`（Host 服务） | 持久化配置 | 阈值/开关/模型 |
| `llm.stream(options)`（Host 服务） | 独立模型调用 | 精炼摘要用（复用会话 provider + 最小模型） |
| `agents.currentInitiator()`（Host 服务） | 会话上下文 | 把流映射到 sessionId（探测确认） |
| `agent/request`（Host 事件） | waterfall | 扩展点：未来改 reasoning effort |

### ✅ 运行时探测已完成（M1，结论见 probe-notes.md）
- **thinking 增量块**：`{ type: 'reasoning-delta', index, text }`；块结构
  `block-start { blockType: reasoning|text|tool-call }` → deltas → `block-end`，
  终态 `usage` + `finish`。
- **GenerateOptions 直接带 `sessionId`**：会话归属首选，`agents.currentInitiator()`
  兜底（实测流迭代期可用）。
- **兜底路径**：`assistant/chunk` 事件的 `data.chunk` 与实时流同构；终态
  `assistant/message` 的 `data.message.content` 块类型 = `reasoning`/`text`/`tool-call`（M2 已探测）。

---

## 4. 模块设计

### 4.1 检测模块（detect）

- **输入**：`llm/stream` 包裹器逐块回调；输出：`thinkingTokenCount` 累计值。
- **chunk 分类**：thinking chunk 判定函数（探测后确定）；非 thinking（content、tool、finish）只透传，不参与计数。
- **token 估算**：轻量启发式，不调任何分词服务：
  - 基础：`chars / 4`；
  - CJK 自适应：文本中 CJK 占比高时按 `chars / 1.5` 计（中文约 1 token/字），避免严重低估。
- **阈值**：`thinkThresholdTokens = 2000`（默认）——累计超过即判定"进入长思考"，开启分段。阈值前不做任何分配（除了一个滚动计数器，O(1)）。
- **会话归属**：优先 `agents.currentInitiator()` → `session.id`；降级哈希键控（见 §3 探测）。
- **过滤**：`llm/stream` 覆盖**所有**模型调用（子代理、标题生成、workflow 等）。只处理携带 agent-loop 请求标记（`markAgentLoopRequest`）或能解析到目标会话的流；标题生成等旁路流一律跳过（否则会产生噪声总结）。

### 4.2 分段模块（segment）

实时约束：**只缓存"未总结余量"，切段即清空**，缓冲区硬上限 = `segmentMaxTokens`，内存 O(窗口)。

- **双阈值**：
  - `segmentMinTokens = 1500`：达到后可切（等待语义边界信号）；
  - `segmentMaxTokens = 3000`：硬上限，到点强制切，保证缓冲有界（切点**回溯到最近句末/行末**，不在句中/词中切）。
- **Markdown 结构感知**（v0.2，详见 `segment-optimization.md`）：
  - 围栏状态机：围栏**内不做任何边界测试**（`- 列表`、`### 标题`、`Step 1` 等代码内容不会误切）；代码块整体原子（max 超限只在围栏边界切，纯代码段在代码行间切）；
  - 表格整体原子（表头+分隔行+行，max 超限只在行边界切）；列表只按**项边界**切（无序/有序/任务项）；
  - 边界信号（达最小窗口后，切在**行前**、边界行进下一段）：标题、无序/有序/任务列表项、引用、分隔线、**行首结构词**（`其次 / 接下来 / 然后 / Finally / Second / Step N`）；
  - 围栏闭合为强边界（切在行后，代码段收尾；闭合行与后续内容同增量到达时由闭合事件驱动，不依赖尾行测试）；
  - **块切换是天然强边界**（探测确认）：`block-start` 的 `blockType` 从 `reasoning` 切到 `tool-call`/`text`，即"思考段结束"，`signalBoundary()` 触发切段（需达最小窗口）。
- **流结束 flush**：末尾不完整段也要总结（`finish` 或迭代终止触发）；低于下限（64 tok）的小尾巴丢弃（省 token 规则④）。
- **阈值门控产出**：阈值（2000）前切出的首段不入 state（长思考判定后才开始总结），检测器仍累计全部 token。
- **去重**：state 级段哈希集合（`hashes`，view 时剥离）——`llm/stream` 随重试/重放被再次包裹也不会重复总结同一段。
- **段元数据**：每段附带 `codeRatio`（围栏内字符占比）与 `isTable`，供"跳过代码段/表格段精炼"决策（省 token，见 4.3.2）。

### 4.3 总结模块（summarize）

#### 4.3.1 启发式提取器（默认即时、0 token）
对切出的段文本同步运行，O(段长)：
- 抽取：首句（主题句）、含代码标识符/文件路径的行、要点行（`- / * / 1.`）、小节标题、结论性句子（`因此 / 结论 / 关键`）；
- 输出模板化摘要：`{ 主题候选, 要点[], 涉及文件/符号[] }`，渲染为 1–3 行。
- **代码块/表格段结构化摘要**（v0.2）：纯代码段 → `代码块 · <语言> · 约 N 行 | <首行>`；纯表格段 → `表格 · N 行 · 列: <表头>`（均 0 token，UI 标注"代码段·未精炼"/"表格·未精炼"）。

#### 4.3.2 小模型精炼（按需、可关）
- **触发门控**（省 token 核心）：全局精炼开关开 **且** 段非代码段/表格段（`codeBlockMode`/`tableMode` 三态：默认 `ignore` 内容不写内存只留元信息段；`keep-skip` 保留+结构化摘要不精炼；`keep-refine` 保留并精炼）。开启即全量精炼可精炼段，不做段大小门控。
- **模型来源**：复用会话当前 provider，`llm.listModels` 选最小可用模型（`refineModel: 'auto'`）；目录不可用时回退主模型；不另配凭据。
- **请求契约（探测确认，probe-notes.md §M3）**：`messages[].content` 必须是内容块 `[{type:'text',text}]`（字符串会被拒）；`system` 走顶层字段；该 provider **不支持** `reasoningEffort`（设置会报错）；模型总是先推理——`maxTokens`（API 预算，默认 1024）必须覆盖推理+答案，预算不足会卡在 `finish{kind:'max-tokens'}` 不出答案。
- **输入输出硬限制**：输入裁剪三档（`refineTrim`）：`headtail` 头尾裁剪（默认，保头 ~30% + 尾 ~70%，丢中段）/ `tail` 仅保尾部 / `full` 完整保留（不裁剪，最耗 token）；输出 `min(段, 预算)`；提示词为固定短模板；答案展示时截断到 ~60 token（240 字符）。
- **并发与取消**：独立队列，并发上限 1；**绝不 await 在主流迭代内**（fire-and-forget）；主流 error/abort 时**按 (会话, think) 精确取消**（不打断旧思考未完成的精炼）；正常 finish 让队列自然排空（精炼调用本身很短，~1.5s）。
- **错误隔离**：精炼任何异常只影响该段摘要（回退到启发式结果），吞掉并记录，**不影响主请求**。
- **实测成本**（deepseek-v4-flash）：单次精炼 ≈ 777 in + 67 out ≈ **0.85k token，~1.4s**；10k 思考链约 3–4 次精炼 ≈ 3–4k token，与成本模型一致。

#### 4.3.3 兜底路径（事后）
`session/event`：`assistant/chunk`（`data.chunk` 与实时流同构）按 `sessionId+turn+step`
累积 reasoning-delta 文本（缓冲设上限、按年龄清理）；`assistant/message`（每步终态，
`data.message.content` 块类型 `reasoning`/`text`/`tool-call`）时，若实时路径未产出
（断流/异常/错过），对该步文本补跑分段+启发式总结并**追加**进会话状态，
`thinkingTokens` 累计、达阈值才置 `inSplice`。

### 4.4 状态存储（state）

> **修正记录（M2 审查后）**：初稿键控 `sessionId + turn`，但探测确认 `GenerateOptions`
> **无 turn 字段**（流上不可知），故改为**会话级键控 + 空闲 TTL 清理**（10 min）：
> 同一会话多步/多轮连续流共享一个状态（段索引单调递增），客户端只展示最近 8 段；
> 兜底路径按 `sessionId+turn+step` 缓冲、追加进同一会话状态。内存有界、跨轮不脏。

- 内存态，键：`sessionId`；结构：
  ```
  {
    active: boolean,
    thinkingTokens: number,
    inSplice: boolean,
    segments: [ { index, summary, tokens, refined: boolean, ts } ],
    updatedAt: number,
    hashes: Set<string>   // 内部去重，view() 剥离
  }
  ```
- 生命周期：流开始创建/复位 → 流结束标记 `active:false` → 保留 N 分钟供 UI 查看 → 清理。
- 只存标量/自有 JSON，不序列化任何 Cordis 活对象。

### 4.5 RPC 与 UI

- **Host**：`harness.handle('think-summary/state', { sessionId, turn })` → 返回上述状态 JSON（null 表示无活动）。
- **Client**：注册 `conversation.input.dock`（id: `think-summary.panel`），组件：
  - 轮询 `host.call`（~1.5s），仅在 `active` 或近 2 分钟内有过活动时轮询，空闲即停（省电/省 RPC）；
  - 渲染**摘要列表**：`第 N 段 · 摘要 · 耗时`，思考中实时滚动追加；
  - 面板只在长思考被触发后出现（平时零占用）。
- 槽位 props 与注册协议以实现时 `Slots` 查询为准（session 作用域，可拿 sessionId）。

---

## 5. 省 token 成本模型

| 环节 | 成本 | 说明 |
|---|---|---|
| 检测 | 0 | 纯计数，O(1) |
| 分段 | 0 | 正则/信号判定，O(窗口) |
| 启发式总结 | 0 | 同步文本提取 |
| 精炼（实测） | 每段 ~0.85k token（777 in + 67 out，deepseek-v4-flash） | 仅"肥"段触发；10k token 思考 ≈ 3–4 段 ≈ **3–4k token 总开销** |
| UI 轮询 | 0（无 LLM token） | 本地 JSON，1.5s 一次，空闲即停 |

**四条硬规则**：① 长思考阈值不过不分段；② 精炼输入硬截断 1500；③ 输出上限 60；④ 小段合并/跳过 + 并发 1 + 结束取消。

---

## 6. 配置项（settings 持久化）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `thinkThresholdTokens` | `2000` | 长思考判定阈值 |
| `segmentMinTokens` | `1500` | 段最小窗口 |
| `segmentMaxTokens` | `3000` | 段硬上限（缓冲上限） |
| `filterNonAgentLoop` | `true` | 只处理带 sessionId 的请求（旁路流过滤） |
| `refineEnabled` | `true` | 小模型精炼开关 |
| `refineMinSegmentTokens` | `1200` | 精炼触发门槛（"肥"段） |
| `refineMaxInputTokens` | `1500` | 精炼输入截断（段尾部） |
| `refineOutputTokens` | `1024` | 精炼 API 完成预算（推理+答案） |
| `refineModel` | `'auto'` | `'auto'` = 会话 provider 最小模型；可显式指定 |

设置 UI（M4 已实现）：Host 注册 `@deepseek-ai/dsh-settings` 命名空间
（schemastery schema + `installSettingsSection`，`setSource/onChange` 实时生效）；
客户端在 **`settings.plugin.item`**（官方插件配置区）注册 think-summary 卡片，
经 `ctx.settingsScope.bind({namespace})` 读写。

---

## 7. 发布形态：独立仓库包

```
dsh-think-summary/
├── package.json          # name: dsh-think-summary；dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # web profile 补丁：插入插件行
├── tsconfig.json
├── scripts/
│   └── build-client.mjs  # 客户端 bundle 打包（ModuleLoader 格式，零依赖）
├── src/
│   ├── index.ts          # 插件根：settings 命名空间 + apply() 接线
│   ├── host/
│   │   ├── config.ts     # 共享配置类型与默认值
│   │   ├── detect.ts     # thinking token 计数 + 阈值 + 过滤旁路流
│   │   ├── segment.ts    # 双阈值 + 语义边界 + 缓冲管理 + flush/去重
│   │   ├── pipeline.ts   # 共享总结管线（兜底用）
│   │   ├── summarize/
│   │   │   ├── heuristic.ts   # 0 token 提取器
│   │   │   └── refine.ts      # 小模型精炼：队列/并发 1/取消/错误隔离
│   │   ├── state.ts      # 会话级内存态 + TTL 清理
│   │   ├── rpc.ts        # 双传输：webServer 路由 + harness.handle
│   │   └── fallback.ts   # session/event 事后兜底
│   └── client/
│       ├── index.js      # 入口（apply/slots 组装）
│       ├── settings.js   # 设置卡片（自建 loopback 桥）
│       ├── dock.js       # 输入框上方实时面板
│       ├── tail.js       # 聊天流内思考总结条
│       └── styles.js     # 样式（原生 token）
├── docs/                 # 文档（design / probe-notes / segment-optimization）
└── README.md
```

- **构建**：`tsc` 编译 Host（lib/index.js + 类型）；`scripts/build-client.mjs`
  把纯 JS 客户端包成 DSH web 模块格式（`window.__ModuleLoader__.load`），
  与 dsh-web-ui 生态的 tsdown 产物同构但零依赖、可复现。
- **安装（多路通用）**：
  1. `dsh plugin --profile web add link:<repo>` —— 本地开发（符号链接 + 自动补丁）；
  2. `dsh plugin --profile web add dsh-think-summary` —— npm 包；
  3. 手动 `cordis.yml` 行（`- path:` / `- pkg:`）—— 仅 Host 面；
  4. 手动 web profile `cordis.patch.yml` 插入行。
- **RPC 传输**：发布版走 `webServer` 路由 `/api/think-summary/state`（浏览器
  fetch，客户端同源）；动态插件开发版保留 `harness.handle`，两者共存。
- **设置页**：`settings.plugin.item` 卡片（官方插件配置区）+ `settingsScope` 读写。

---

## 8. 容错与边界

1. **零侵入主流**：包裹器惰性、不缓冲、不抛错；任何内部异常捕获后吞掉，绝不冒泡到模型请求。
2. **旁路流过滤**：子代理/标题生成/workflow 流不进入管道（§4.1 过滤）。
3. **重试/重放**：按请求身份键控 + 段哈希去重，重复计算无害。
4. **多会话隔离**：状态按 `sessionId+turn` 键控，互不干扰；会话销毁即清理。
5. **限流**：精炼并发 1、队列有界，过载直接跳过精炼（启发式仍在）。
6. **UI 失败无关紧要**：面板渲染/轮询异常不影响聊天主界面。
7. **内存**：段缓冲有硬上限；状态保留 N 分钟后清理。

---

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 探测+骨架** ✅ | 运行时探测（chunk 形状/块名/sessionId）；`llm/stream` 包裹器；token 计数 + 阈值；state + RPC + 最小 UI | 已完成：探测结论见 probe-notes.md；实机验证旁路流不触发 |
| **M2 分段+启发式** ✅ | 双阈值 + 语义边界 + flush/去重；启发式提取器；摘要列表；`session/event` 兜底；审查驱动的修复 | 已完成：实机（短流零产出/块切换信号）+ 合成（边界多段/硬上限有界/短尾巴 0 段）验证通过 |
| **M3 精炼** ✅ | 小模型队列（并发 1、门控、截断、取消、错误隔离） | 已完成：实机探测确认请求契约（块 content / maxTokens 1024 / 无 reasoningEffort），实测单次 ~0.85k token |
| **M4 发布打磨** ✅ | 多安装方式 + 设置页 + 构建脚本 | 已完成：`dsh plugin add link:/npm` / 手动 cordis.yml / 手动补丁四路通用；settings.plugin.item 设置卡片（settingsScope 读写、实时生效）；`tsc` + ModuleLoader bundle 构建通过，`import('./lib/index.js')` 验证导出 |

---

## 10. 风险与未决项

| 风险 | 影响 | 对策 |
|---|---|---|
| ~~`StreamChunk`/thinking 块字段名未知~~ | ~~M1 阻塞~~ | ✅ 已探测确认（reasoning-delta / block-start.blockType），见 probe-notes.md |
| ~~流→sessionId 归属不明确~~ | ~~状态键控错乱~~ | ✅ `options.sessionId` 直取，initiator 兜底，双保险 |
| `llm/stream` 覆盖全部模型调用 | 噪声总结/重复计算 | 无 sessionId 的旁路流过滤（filterNonAgentLoop）+ 去重 |
| 小模型精炼并发与 API 限流 | 精炼失败 | 并发 1 + 队列有界 + 失败回退启发式 |
| CJK token 估算偏差 | 阈值失真 | CJK 自适应系数，M2 校准 |
| 轮询 vs 未来推送 | UI 时效 | v1 轮询足够（本地 JSON）；预留投影/推送升级点 |
| `assistant/message` 内容块名未知 | M2 兜底阻塞 | ✅ 已探测：`reasoning` / `text` / `tool-call`（probe-notes.md §4） |

---

*决策记录：实时拦截为主+日志兜底 · 混合总结引擎 · 仅 UI 展示不写回上下文 · input.dock 实时面板（仅摘要列表）· 独立仓库包 · 默认参数 2000/1500/3000/60 · 精炼复用会话 provider 最小模型。*
