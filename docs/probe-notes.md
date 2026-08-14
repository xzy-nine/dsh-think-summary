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
