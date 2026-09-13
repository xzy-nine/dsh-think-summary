# dsh-think-summary

> DSH（Cordis 架构）双面插件：**长思考链分段总结** —— 检测模型的长思考，边思考边分段，
> 逐段产出摘要，实时展示在聊天区，附带设置页与历史持久化。

- 版本：`0.1.4`（npm 标签 `v0.1.1` / `v0.1.2`）
- 许可：[MIT](./LICENSE)
- Host 半面（检测 / 分段 / 总结 / 精炼 / 持久化）：`src/host/*`，TypeScript → `lib/`
- 客户端半面（面板 / 总结条 / 视图 / 设置卡）：`src/client/*`，纯 JS → `lib/client.js`

---

## 特性

- **长思考检测**：`llm/stream` 瀑布实时观察 `reasoning-delta`，轻量 token 计数
  （CJK 自适应、原始计数不取整），超过阈值自动进入分段模式；默认过滤
  旁路流（`GenerateOptions.purpose` 非空 = 压缩/标题生成等辅助调用；无 purpose
  的旧宿主回退 sessionId 启发式）。
- **语义分段**：双阈值（最小窗口 1500 / 硬上限 3000 token）+ **Markdown 结构感知**
  （围栏状态机——代码块整体原子、围栏内不误切；表格整体保留；列表只在项边界切；
  标题/有序列表/任务项/引用/分隔线/行首结构词边界；max 强制切回溯到最近句末/行末；
  `blockType` 切换强信号），只缓存未总结余量，内存有界、state 级哈希去重。
- **代码块/表格三态处理**：`ignore`（默认，内容不写内存、不计段 token、不精炼，
  总结卡片**不显示**任何代码块/表格痕迹）/ `keep-skip`（保留+结构化摘要、
  跳过精炼）/ `keep-refine`（保留并精炼）；总思考 token（阈值/进度）始终计入代码量。
- **逐段总结**：启发式提取（0 token）即时出；**精炼**用所选供应商的最小可用
  模型精炼可精炼段（`refineProvider` 默认 `auto` 跟随主请求，**可手动指定其他
  已注册供应商**；输入预算 + 裁剪三档：头尾 / 仅尾部 / 完整保留；展示截断
  ~60 token；并发池默认 3、任务互不打断、超时释放并发位；异常自动回退启发式并
  在段上标注原因）；段头同时显示**原始输出 token**（含被忽略的代码/表格）与
  **精炼实际 token**（输入裁剪后 + 输出摘要）。
- **实时面板**：composer 上方实时面板（思考进度 + 滚动分段摘要，仅"对话"视图
  显示），客户端每 1.5s 轮询 `/api/think-summary/state`；总结**不写回会话上下文**，
  零污染。
- **对话体内每步总结卡**：插在该步**思考行之后、正文之前**（对话体内、跟随滚动、流式期间就在）。
  做法是**委托官方 `assistant-step`**：先取官方条目的 component 与 `locale`，再以同一 key、
  **更低 priority**（keyed 槽位要求不同优先级，越低越优先渲染）注册；把该步内容块拆成
  `reasoning` 与其余两半、**都用官方渲染器渲染**，卡片夹在中间——绝不自己实现 markdown。
  官方组件取不到时**不注册**（退回只有输入框上方面板），并以更低 priority + 错误边界兜底。
  折叠规则：**最近 2 张展开**，更早的自动折叠（第 3 张出现时第 1 张收起，依次循环）；
  手动点过以手动为准。
- **两级摘要**：卡片第一行常显**整体摘要**（加粗；第二遍：把分段摘要再喂一次模型，1.2s 防抖），
  下面**一行一条**列出各分段摘要（`nowrap + ellipsis`、淡入出现，模仿流式思考链），
  未精炼行淡一档、悬停显示原因与「再试」。
- **短段也总结**：`MIN_SEGMENT_FLOOR` 已从 64 改为 **0**，几个字的尾巴照样出段并精炼；
  同时**长思考门控默认关闭**（`thinkThresholdTokens: 0`）——否则几十 token 的 step 会被
  整段跳过，表现就是"只有第一个思考有卡片，后面的都没有"。
- **思考总结视图**：会话头部"思考总结"选项卡，列出当前会话**全部**被记录的
  思考（每段摘要 + 原始/精炼双 token + 状态标签），可折叠、自动滚底、
  折叠状态 localStorage 持久化。
- **视图页「再试」**：每个未精炼段右侧一个**再试**按钮，展开的卡片顶部还有
  **重试全部未精炼 · N** 批量按钮——用段原文重新入队精炼（失败/超时/中断过的段
  不必重发消息即可补跑）。段原文随状态持久化，重启后仍可重试；
  0.1.4 之前落盘的旧记录没有原文，按钮置灰并提示原因。
- **事后兜底**：`session/event` 事件流断流/异常时补跑分段总结，不丢摘要，
  兜底分段同样入队精炼（用会话默认模型）。
- **主模型自产小结**（可选，默认关）：`selfSummary` 设为 `prompt` 后，向系统提示词
  注入小结指令，流内捕获【思考小结】标记直接展示（仅展示补充，不影响外部分段）。
- **持久化**：思考总结保存到 `~/.dsh/dsh-think-summary.json`（原子写：tmp+rename、
  每次状态变更同步落盘），重启 dsh 后仍可查看历史总结；支持已归档会话的
  自动/手动清理（默认宽限保留最近 24h，防误清）。
- **设置页**：官方插件配置区卡片（自建 loopback 设置桥，分组可折叠），改动即时生效。

## 界面预览

思考进行中，输入框上方的实时面板逐段滚动展示摘要（左侧），会话头部的
"思考总结"选项卡汇总当前会话全部历史总结（右侧）：

![输入框上方实时思考总结卡片](assets/screenshots/输入框上方实时思考总结卡片.webp)

![历史思考总结选项卡](assets/screenshots/历史思考总结选项卡.webp)

## 架构速览

```
模型流 ─► llm/stream 包裹（检测+分段+启发式总结+精炼入队）──► state（会话级）
                                                                  │
session/event 兜底补跑 ◄──────────────────────────────┐          │
                                                      ▼          ▼
                    持久化：~/.dsh/dsh-think-summary.json ◄── 原子写（每次变更）
                                                      │
   客户端：settings.plugin.item 设置卡 ◄─ loopback 设置桥 ─ /api/think-summary/*
   客户端：conversation.input.dock 实时面板 ◄── 轮询 ── /api/think-summary/state
   客户端：conversation.chat.turnTail 回复末尾总结条 ◄── 有限重试 ── /api/think-summary/state
   客户端：conversation.view "思考总结"选项卡 ◄── 轮询 ── /api/think-summary/state
```

## 安装（多路通用）

同时兼容 **DSH web profile 插件机制**（Host + 浏览器双面）与 **纯 Cordis 装载**（仅 Host 面）。

> 宿主版本适配（0.1.5-rc.2 起）：设置命名空间经 **`ctx.get('settings')` 服务
> 的 `installSection()`** 注册——`@deepseek-ai/dsh-settings` 已不再导出
> `installSettingsSection` / `settingsNamespace`，而外部 profile 的行也解析不到
> `@deepseek-ai/dsh-*` 包，因此 Host 半面的唯一运行期依赖是 `schemastery`。
> 客户端插槽（`settings.plugin.item` keyed、`conversation.chat.turnTail` chain、
> `conversation.input.dock`、`conversation.view`）与 `llm.stream` / `llm.listModels` /
> `llm.resolveModelInfo` / `llm.listProviders` 均按该版本实测接线。

### 方式一：本地开发（符号链接 + 自动补丁）⭐

```bash
dsh plugin --profile web add link:/绝对/路径/to/dsh-think-summary
# Windows 示例：dsh plugin --profile web add link:D:/Files/zzj/Programs/webs/dsh-plugins/dsh-think-summary
# 卸载
dsh plugin --profile web remove dsh-think-summary
```

该命令在 `~/.dsh/profiles/web/` 下完成三件事：向 `package.json` 写入
`link:` 依赖、在 `node_modules` 建立符号链接、把包加入 `dsh.profile.bundles`
（由包内 `dsh.bundle.patch` 声明的 `cordis.patch.yml` 补丁层生效，插入
`think-summary` 插件行）。浏览器客户端经 `dsh.client` 声明装载于
`/plugins/dsh-think-summary/client.js`。**需要本机可用的 pnpm**。

### 方式二：npm 包（发布后）

```bash
npm publish            # 或私有 registry
dsh plugin --profile web add dsh-think-summary
```

### 方式三：手动 cordis.yml 行（仅 Host 面，无浏览器 UI）

```yaml
- path: /绝对/路径/to/dsh-think-summary   # 本地路径
# 或
- pkg: dsh-think-summary                  # npm 包名
```

此方式只装载 Host 面（检测 / 分段 / 总结 / 精炼 / 持久化均可用），无设置页与实时面板。

### 方式四：手动 web profile 补丁（不依赖 CLI / pnpm）

1. 建立符号链接（Windows 用 junction）：

```powershell
# 链接放在 profiles/node_modules（宿主按 $DSH_HOME 兜底解析裸包名；web/node_modules 亦可）
New-Item -ItemType Junction -Path "$HOME\.dsh\profiles\node_modules\dsh-think-summary" `
  -Target "D:\Files\zzj\Programs\webs\dsh-plugins\dsh-think-summary"
```

2. 二选一接线：

```yaml
# a) 编辑 ~/.dsh/profiles/web/package.json，把包加入 dsh.profile.bundles：
#    "bundles": ["@deepseek-ai/dsh-base", ..., "dsh-think-summary"]
# b) 或编辑 ~/.dsh/profiles/web/cordis.patch.yml 追加：
- insert:
    - id: think-summary
      name: 'dsh-think-summary'
```

3. 生效：web profile 的补丁层是 `patchReload: live`（改 `cordis.patch.yml` 即热装载，
无需重启）；若链接建在 `web/node_modules` 下，重启 dsh web 更稳妥。

## 设置

侧边栏 设置 → 插件配置 → think-summary 卡片（默认折叠，分组展开）：

| 分组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| （顶部） | 启用插件 | `true` | 总开关：关闭后不检测/不分段/不精炼/不注入提示词，客户端总结 UI 全部隐藏 |
| 检测与分段 | 长思考阈值 | `0` | **0 = 不门控**：任何思考（哪怕几十 token）都分段并总结；调大则只在超长思考时才产出（原作者默认 2000，会让多数 step 完全没有总结） |
| 检测与分段 | 段最小窗口 | `1500` | 达到后可切（等待语义边界信号） |
| 检测与分段 | 段硬上限 | `3000` | 到点强制切（回溯到最近句末/行末），保证缓冲有界 |
| 小模型精炼 | 精炼 | `true` | 开启后所有**可精炼**分段都用所选供应商的最小模型精炼摘要 |
| 小模型精炼 | 代码块处理 | `ignore` | 忽略（内容不写内存、不精炼、卡片不显示）/ 保留+跳过精炼 / 保留并精炼 |
| 小模型精炼 | 表格处理 | `ignore` | 同上 |
| 小模型精炼 | 精炼输入裁剪 | `headtail` | 头尾（保主题+结论、丢中段）/ 仅尾部 / 完整保留（不裁剪） |
| 小模型精炼 | 精炼输入预算 | `800` | 喂给小模型的段文本预算（token），按上方裁剪策略裁剪后 |
| 小模型精炼 | 精炼预算 | `512` | 精炼 API 完成预算（推理 + 答案），token；关思考的模型 512 够用，未关思考的推理型模型建议 ≥1024 |
| 小模型精炼 | 精炼最小段 | `0` | 低于该值的段跳过精炼、保留启发式摘要；**0（默认）= 每个段都精炼** |
| 小模型精炼 | 精炼并发 | `3` | 并行精炼数；任务之间互不打断 |
| 小模型精炼 | 精炼超时 | `60` | 单任务超时（秒）；卡死任务超时放弃并释放并发位 |
| 小模型精炼 | 精炼供应商 | `auto` | 下拉选择：`auto`（推荐）= 精炼时跟随主请求的供应商；或手动指定**任一已注册供应商**（列表来自 `llm.listProviders()`，可选用其他供应商的模型做精炼） |
| 小模型精炼 | 精炼模型 | `auto` | 下拉选择：`auto`（推荐）= 精炼时自动选用**所选供应商**目录中上下文窗口最小的可用模型；或从该供应商的模型列表固定指定 |
| 小模型精炼 | 精炼提示词 | 动向摘要模板 | 第一遍（分段）：角色（"只写动向摘要，**不要回答片段里的问题、不要接话**"）+ **一个示例** + 硬规则（中文·第一人称·≤30 字·只输出一句）；片段包裹与"要求后置"由代码固定（`REFINE_USER_TEMPLATE`） |
| 小模型精炼 | 整体摘要提示词 | 动向合并模板 | 第二遍：把**分段摘要**再喂一次模型，得到一句覆盖整次思考的整体动向；卡片头部常显这一句，段列表折叠 |
| 主模型自产小结 | 模式 | `off` | 关闭 / `prompt`（注入提示词并流内捕获【思考小结】直接展示） |
| 存储与清理 | 持久化保存 | `true` | 保存思考总结到 `~/.dsh/dsh-think-summary.json`，重启后仍可查看 |
| 存储与清理 | 自动清理 | `false` | 定期清理已归档（非活跃）会话的思考总结 |
| 存储与清理 | 归档保留天数 | `30` | 会话归档（非活跃）超过该天数后自动清理其总结 |
| 存储与清理 | 立即清理（按钮） | — | 立即删除所有非活跃会话的思考总结（默认宽限保留最近 24h） |

> 另有 schema 级默认项（设置卡未暴露，可用配置/持久化直写）：
> `filterNonAgentLoop`（默认 `true`，过滤 purpose 非空或缺失 sessionId 的旁路流）。
>
> **摘要归一化**（0.1.4）：模型返回小作文时只取第一行/第一句，去掉列表符、编号、
> 标题、引号与"总结："类前导词，超过 60 字符截断；归一化后为空则按精炼失败处理
> （写回原因、保留启发式摘要）——避免"没真精炼却标记已精炼"。
> 段头 token 标注为 `精炼 输入→输出 tok`，不再把两者相加成一个大数。
> **两级摘要**：段摘要（第一遍）+ 整体摘要（第二遍）——卡片头部常显整体摘要，
> 段列表默认折叠。折叠状态记忆：设置卡/视图卡/每步总结卡（默认折叠）/"上次思考"行（默认展开）。

改动即时生效（阈值/开关在每次流开始时读取），无需重启。

## 使用与验证

1. 触发长思考：向模型提出需要深度推理的问题（超过 `长思考阈值`）。
2. 思考进行中，composer 上方出现实时面板：`● 思考中 · N tok · M 段`，
   分段摘要滚动追加；开启精炼的段稍后标记"已精炼"。
3. 思考结束面板转为"思考结束"；下一次思考积累期会保留上次总结作为参照。
4. 每条回复末尾出现可折叠的"思考总结"条（该 turn 所有有段思考，按 step 分组）；
   会话头部的"思考总结"选项卡可查看当前会话全部历史总结。
5. 阈值内的短思考不产出分段（不打扰）；代码块/表格在 `ignore` 模式下不显示任何痕迹。

## HTTP 接口（Host 提供，浏览器同源直连）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/think-summary/state?sessionId=` | 会话思考状态视图（`enabled` + `paused` + `state`；sessionId 缺省用最近活跃会话） |
| GET | `/api/think-summary/models` | 精炼供应商/模型下拉数据源：已注册供应商目录 + 各供应商可用模型 + 当前默认选中模型 |
| POST | `/api/think-summary/settings/describe` | 设置命名空间视图（value/base/user/revision/writable） |
| POST | `/api/think-summary/settings/mutate` | 逐字段 set/unset（revision 围栏） |
| POST | `/api/think-summary/clear-archived` | 清理已归档会话总结（`{ graceMs? }`，缺省保留最近 24h） |
| POST | `/api/think-summary/pause` | 切换全局暂停（`{ paused }`）：暂停后不再产出新总结，旧内容保留 |
| POST | `/api/think-summary/refine` | 视图页「再试」：`{ sessionId?, thinkId?, segmentIndex?, all? }` → 重新入队精炼，返回 `{ ok, queued, refused, matched }` |

settings / clear-archived / pause / refine 接口为 loopback-only（拒绝非本机来源）。

## 开发

```bash
npm install
npm run build      # tsc 编译 Host + 打包客户端 bundle（lib/client.js）
npm run typecheck
node scripts/seg-check.mjs     # 分段算法回归（围栏原子/表格整体/句末回溯/元数据）
node scripts/order-check.mjs   # 客户端 bundle 模块顺序检查
node scripts/refine-check.mjs  # 精炼回归（失败终态上报 + 供应商/模型路由解析）
```

内部设计文档（design / probe-notes / segment-optimization / self-summary-mode）
保留在仓库根 `docs/` 目录，仅贡献者可见，**不随 npm 包发布**。

### 调试循环（改码 → 生效）

```bash
npm run watch:all     # 并行：tsc --watch（Host → lib/）+ 客户端 bundle watch
```

| 改动位置 | 生效方式 |
|---|---|
| `src/client/*.js`（面板/总结条/视图/设置页/样式） | bundle 自动重建后**刷新浏览器**即生效，无需重启 dsh |
| `src/host/*.ts`（检测/分段/总结/精炼/持久化） | `lib/` 编译后**重启 dsh web** 生效 |

只盯客户端时单独跑 `npm run watch:client`（仅监听 `src/client/`，更省资源）。

> 客户端 bundle 由宿主实时读取（改后刷新浏览器即生效）；Host 半面改动需重启 dsh。

### 部署要点（实测确认）

0.1.5-rc.2 实测：官方设置控制器（`settingsController.describe`）返回**全部已注册
命名空间**（不再按白名单过滤），因此本插件也出现在“设置 → 插件配置”的卡片列表中。
本插件仍保留自建 loopback 设置桥：`POST /api/think-summary/settings/describe|mutate`
（宿主直连 settings 服务、revision 围栏），客户端用迷你 scope 控制器读写，不依赖
任何家族清单。

### 精炼失败排查

段的“未精炼原因”会写明具体失败原因（`<provider>/<model> error：<code> HTTP <status> <message>`）。
若某段有段大小、开关也开着却一直显示 **“待精炼”**，说明宿主里跑的是 0.1.3 之前的代码
（旧版只累计 `text-delta`，把 provider 的终态失败 chunk 静默吞掉）——**重启 dsh web** 即可。

常见的 provider 侧原因：

- `... error：PROVIDER_HTTP_ERROR HTTP 404 ...`：`api: openai-completions` 的
  `baseURL` 必须是 OpenAI 兼容根（Ollama 是 `http://127.0.0.1:11434/v1`，
  写成 `/api/chat` 会被拼成 `/api/chat/chat/completions` 而 404）。
- `未返回文本（finish=max-tokens）：预算被推理耗尽`：该模型先推理且推理很长
  （小模型实测一轮 370+ 个 reasoning 增量），把「精炼预算」调大（如 2048），
  **或者干脆关掉该模型的思考**（见下）。
- `未注册，已回退主请求 provider`：设置里选的供应商已被卸载/改名，重选即可。
- `摘要不是中文：「...」`：模型"接话"了（回英文、回片段里的问题）——**语言硬校验**
  拒收，段保留启发式摘要并标注原因。0.1.4 已把请求结构改成"示例 + 分隔符包裹 +
  要求写在片段之后"，正常不会再出现；换模型/改提示词后又出现时点「再试」即可。

### 关于摘要质量与模型选择（0.1.4 实测）

**"模型接话"不是模型太小，是请求结构问题**：把思考原文直接当 user 消息发过去，
4b/2b 都会顺着往下想（回 "Understood. I'll proceed to:"）。改成
`system（角色+示例+规则） + user（【思考片段开始】…【思考片段结束】+ 要求）` 后，
短样本上两个模型都达标：

| 样本（英文思考） | qwen3.5:4b | qwen3.5:2b |
|---|---|---|
| 英文·结论口吻 | 21 字 ✓ 27.7s（冷启动） | 31 字 ✓ 205ms |
| 英文·接话口吻 | 28 字 ✓ 283ms | 32 字 ✓ 227ms |
| 中文·分析 | 29 字 ✓ 305ms | 26 字 ✓ 186ms |
| 中文·长推理 | 33 字 ✓ 395ms | 48 字 ✓ 239ms |

但**真实长片段上 4b 明显更强**（2611 字符 ≈ 653 tok 的英文排障推理，结论埋在末尾）：

| 模型 | 入库摘要 | 评价 |
|---|---|---|
| `qwen3.5:4b` | `我怀疑是配置中的 maxUses 被设为了巨大的 1e72。` | 30 字、第一人称、**抓到唯一结论** |
| `qwen3.5:2b` | `正在排查 max_uses 配置，怀疑是数值过大导致序列化异常。` | 32 字、**非第一人称**、只泛化出主题 |

结论：**默认用 4b**；2b 只在"要更快、且能接受偶尔泛化/丢第一人称"时用。
（两者冷启动都要 20–30s，热起来 0.2–1s。）

**输入远长于输出是正常的**：一段 ~800 tok 的思考压成一句话，输入自然是输出的几十倍。
注意 `refineTrim: full` 表示**完整发送、忽略「精炼输入预算」**——只要
`segmentMaxTokens` 不超过所选模型的上下文（Ollama 默认 4096）就没问题；
想更快/更省就切回 `headtail`（按预算保头尾、丢中段）。

**并发不是瓶颈**：Ollama 内部串行，实测同一模型 3 并发与串行 3 次**总耗时相同**
（4b 602ms vs 598ms，2b 651ms vs 627ms）。并发调大只是多几个在途 HTTP 请求，
本地模型建议 1–2，避免冷启动时堆积。

**冷启动才是慢的来源**：模型空闲被卸载后首条要 ~20–30s（4b 实测 27.7s），
热起来 ~200–400ms。想避免可让 Ollama 常驻：`OLLAMA_KEEP_ALIVE=-1`（或启动时
`ollama run` 保持加载）。

### 关掉精炼模型的思考（可选，强烈推荐小模型）

插件**不发送** `reasoningEffort`，所以思考开关完全由 provider 侧决定。以 Ollama 为例
（`api: openai-completions`），实测 `/v1/chat/completions` **只认 `reasoning_effort`**：

| 请求字段 | 效果 |
|---|---|
| 无 | 思考 11479 字符，35.2s |
| `reasoning_effort: "none"` | **思考 0，0.39s**（唯一有效的关法） |
| `enable_thinking: false` | 被忽略，31.7s |
| `think: false` | 被忽略（那是 `/api/chat` 原生端字段），21.8s |

pi-ai 的 `openai-completions` 适配器默认不发 `reasoning_effort`，需要在 provider 里
声明档位与线格式，并用 `compat.supportsReasoningEffort` 打开：

```yaml
llm-pi-ai:
  providers:
    ollma:
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      compat:
        supportsReasoningEffort: true     # 不开则 pi-ai 不发送该字段
      models:
        - id: qwen3.5:4b
          reasoningEfforts:
            off: none    # ← off 映射到 reasoning_effort: "none"（关思考）
            low: low
            medium: medium
            high: high
```

声明后，**不传 effort 的调用（插件的精炼）默认就落到 `off` → 关思考**，
实测单次精炼从超时（>60s）变成约 7s 完成。

### 版本记录

| 版本 | 变更 |
|---|---|
| `0.1.4` | **总结挪进对话体**：以同一 key **委托官方 `assistant-step`**，官方内容照常渲染、卡片追加在每步下方（跟随滚动、流式期间就在；官方组件取不到则不注册并退回输入框上方面板）；**两级摘要**：段摘要 + **整体摘要**（第二遍：段摘要再喂一次模型，1.2s 防抖、中文硬校验，卡片头部常显、段列表默认折叠）；**修"模型接话"**：请求改为 `system（角色+示例+规则）+ user（分隔符包裹片段，要求后置）`、`temperature: 0`，摘要**中文硬校验**（非中文按失败处理）；**修兜底路径**：`assistant/chunk` 在会话格式 v3 已不存在，改从 `assistant/message` 的 `data.stream` / reasoning 内容块取思考原文；**摘要归一化**（只取第一句 + 去外壳，空则失败）、段头 token 改标 `输入→输出`；**视图页「再试」**（单段 / 批量，段原文随状态持久化）；**默认值收敛为本地小模型口径**（`refineMinTokens=0` 每段都精炼、输入 800、输出 512）；**折叠不再过早**（"上次思考"行默认展开并记住选择） |
| `0.1.3` | **精炼供应商可选**（`refineProvider`：`auto` 跟随主请求，或手动指定任一已注册供应商，含非当前供应商）；`/api/think-summary/models` 改为返回供应商目录 + 各供应商模型；**精炼失败不再静默**（终态 `finish{kind:'error'\|'aborted'}` 与“无文本”都写回段的未精炼原因，并带上 `provider/model` 与实际 HTTP 状态）；适配 DSH 0.1.5-rc.2（设置命名空间改经 `ctx.get('settings').installSection()` 注册，移除已下线的 `@deepseek-ai/dsh-settings` 导入；显式 provider 未注册时回退主请求 provider 并标注原因） |
| `0.1.2` | 适配 dsh 0.1.0-rc.7：keyed 槽位、精确模型查询、`purpose` 旁路流过滤 |

## 许可

[MIT](./LICENSE)
