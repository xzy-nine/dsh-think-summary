# dsh-think-summary

> DSH（Cordis 架构）双面插件：**长思考链分段总结** —— 检测模型的长思考，边思考边分段，
> 逐段产出摘要，实时展示在聊天区，附带设置页与历史持久化。

- 版本：`0.1.5`（npm 标签 `v0.1.1` / `v0.1.2`）
- 许可：[MIT](./LICENSE)
- Host 半面（检测 / 分段 / 总结 / 精炼 / 持久化）：`src/host/*`，TypeScript → `lib/`
- 客户端半面（面板 / 总结条 / 视图 / 设置卡）：`src/client/*`，纯 JS → `lib/client.js`

---

## 特性

- **长思考检测**：`llm/stream` 瀑布实时观察 `reasoning-delta`，超过阈值自动进入分段模式；
  默认过滤旁路流（`GenerateOptions.purpose` 非空 = 压缩/标题生成等辅助调用）。
- **语义分段**：双阈值（最小窗口 1500 / 硬上限 3000 token）+ **Markdown 结构感知**
  （代码块/表格整体原子、列表只在项边界切、强制切回溯到最近句末/行末）；
  内存有界、state 级哈希去重。
- **代码块/表格三态处理**：`ignore`（默认，不显示任何痕迹）/ `keep-skip`（保留+结构化摘要、
  跳过精炼）/ `keep-refine`（保留并精炼）。
- **逐段总结**：启发式提取（0 token）即时出；**精炼**用所选模型（并发池、超时释放、
  异常自动回退启发式并标注原因）。
  - **多模型池**：设置页以气泡形式添加多个「供应商/模型」，摘要与翻译**轮流**取用；
    并发按"每模型"计算（多模型时总并发随模型数放大），失败模型进入**指数退避**
    并由其他模型顶上，单个任务还会**换模型重试**——免费模型各自限流的场景靠这个错开。
  - **输出预算自动收敛**：设置里的「精炼预算」不再原样透传——上限已知时（供应商块声明了
    `maxTokens`）收敛到上限内，避免换供应商就 400（如商汤 `field MaxTokens invalid`）。
  - **可关思考**（`refineDisableReasoning`，默认开）：仅在该模型确实声明可关档位时发送
    `reasoningEffort`，省掉推理开销；未声明则不发送，绝不打挂可用路由。
  - **失败可见**：错误码（`RATE_LIMIT 429` 等）直接显示在卡片上，不必翻日志。
- **任务看板中文补充（手动）**：看板卡片页脚有「翻译为中文」按钮，**点击才翻译**——
  英文条目补成 `原文（中文）`，原文保留；只改渲染，不写会话日志，模型后续读到的计划不受影响。
- **实时面板**：composer 上方实时面板（思考进度 + 滚动分段摘要），每 1.5s 轮询
  `/api/think-summary/state`；总结**不写回会话上下文**，零污染。
- **对话体内每步总结卡**：插在该步思考行之后、正文之前（跟随滚动、流式期间就在）。
  做法是**委托官方 `assistant-step`** 渲染，绝不自己实现 markdown；折叠规则：
  最近 2 张展开，更早的自动折叠，手动点过以手动为准。
- **两级摘要**：卡片常显**整体摘要**（第二遍：分段摘要再喂一次模型），下面一行一条
  列出各分段摘要；未精炼行悬停显示原因与「再试」。
- **短段也总结**：`MIN_SEGMENT_FLOOR = 0`，几个字的尾巴照样出段并精炼；
  长思考门控默认关闭（`thinkThresholdTokens: 0`）。
- **思考总结视图**：会话头部「思考总结」选项卡，列出当前会话全部思考，可折叠、
  自动滚底、折叠状态 localStorage 持久化。
- **视图页「再试」**：未精炼段可单段或批量重新入队精炼（段原文随状态持久化，
  重启后仍可重试；0.1.4 之前落盘的旧记录无原文，按钮置灰）。
- **事后兜底**：`session/event` 事件流断流/异常时补跑分段总结，不丢摘要。
- **主模型自产小结**（可选，默认关）：`selfSummary: prompt` 注入小结指令，流内捕获
  【思考小结】直接展示。
- **持久化**：保存到 `~/.dsh/dsh-think-summary.json`（原子写：tmp+rename），
  重启 dsh 后仍可查看；支持已归档会话的自动/手动清理。
- **设置页**：官方插件配置区卡片（自建 loopback 设置桥，分组可折叠），改动即时生效。

## 界面预览

思考进行中，输入框上方的实时面板逐段滚动展示摘要（左侧），会话头部的
「思考总结」选项卡汇总当前会话全部历史总结（右侧）：

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

### 方式一：本地开发（符号链接 + 自动补丁）⭐

```bash
dsh plugin --profile web add link:/绝对/路径/to/dsh-think-summary
# 卸载
dsh plugin --profile web remove dsh-think-summary
```

该命令在 `~/.dsh/profiles/web/` 下完成三件事：写入 `link:` 依赖、建立符号链接、
把包加入 `dsh.profile.bundles`（由包内 `cordis.patch.yml` 补丁层插入插件行）。
浏览器客户端经 `dsh.client` 声明装载于 `/plugins/dsh-think-summary/client.js`。
**需要本机可用的 pnpm**。

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

### 方式四：手动 web profile 补丁（不依赖 CLI / pnpm）

1. 建立符号链接（Windows 用 junction）到 `~/.dsh/profiles/node_modules/dsh-think-summary`；
2. 二选一接线：把包名加入 `~/.dsh/profiles/web/package.json` 的
   `dsh.profile.bundles`，或编辑 `~/.dsh/profiles/web/cordis.patch.yml` 追加
   `- insert: [{ id: think-summary, name: 'dsh-think-summary' }]`；
3. 生效：补丁层 `patchReload: live`，改 `cordis.patch.yml` 即热装载，无需重启。

## 设置

侧边栏 设置 → 插件配置 → think-summary 卡片（默认折叠，分组展开）：

| 分组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| （顶部） | 启用插件 | `true` | 总开关：关闭后不检测/不分段/不精炼，客户端总结 UI 全部隐藏 |
| 检测与分段 | 长思考阈值 | `0` | **0 = 不门控**：任何思考都分段并总结；调大则只在超长思考时产出 |
| 检测与分段 | 段最小窗口 | `1500` | 达到后可切（等待语义边界信号） |
| 检测与分段 | 段硬上限 | `3000` | 到点强制切（回溯到最近句末/行末） |
| 精炼模型 | 精炼 | `true` | 所有可精炼分段都用所选模型精炼摘要 |
| 精炼模型 | 模型池 | 空 | **多模型气泡**：添加多个「供应商/模型」，摘要与翻译**轮流**取用；每模型各自并发、失败自动退避并由其他模型顶上 |
| 精炼模型 | 每模型并发 | `1` | 每个模型各自的并发上限；总并发 = 模型数 × 该值（免费模型建议 1） |
| 精炼模型 | 换模型重试 | `3` | 单个任务最多试几轮（每轮可能换一个模型），全失败才写回错误 |
| 精炼模型 | 超时 | `60` | 单任务超时（秒），卡死任务超时放弃并释放并发位 |
| 精炼模型 | 关闭思考 | `true` | 请求带 `reasoningEffort` 关掉推理；仅在该模型声明了可关档位时发送 |
| 单模型回退 | 精炼供应商 / 模型 | `auto` | **仅当模型池为空**时生效（池子非空则忽略） |
| 单模型回退 | 精炼并发 | `3` | 单模型模式下的并行数；池子模式改用「每模型并发」 |
| 小模型精炼 | 代码块/表格处理 | `ignore` | 忽略 / 保留+跳过精炼 / 保留并精炼 |
| 小模型精炼 | 精炼输入裁剪 | `headtail` | 头尾（保主题+结论）/ 仅尾部 / 完整保留 |
| 小模型精炼 | 精炼输入预算 | `800` | 喂给小模型的段文本预算（token） |
| 小模型精炼 | 精炼预算 | `512` | 精炼 API 完成预算；**上限已知时自动收敛到供应商上限**，不会因设得过大而 400 |
| 小模型精炼 | 精炼最小段 | `0` | **0（默认）= 每个段都精炼** |
| 小模型精炼 | 分段摘要提示词 | 动向摘要模板 | 第一遍（分段）提示词（角色 + 示例 + 硬规则） |
| 小模型精炼 | 整体摘要提示词 | 动向合并模板 | 第二遍：把分段摘要再喂一次模型得到整体动向 |
| 主模型自产小结 | 模式 | `off` | 关闭 / `prompt`（注入提示词并流内捕获【思考小结】） |
| 存储与清理 | 持久化保存 | `true` | 保存到 `~/.dsh/dsh-think-summary.json`，重启后仍可查看 |
| 存储与清理 | 自动清理 | `false` | 定期清理已归档（非活跃）会话的思考总结 |
| 存储与清理 | 归档保留天数 | `30` | 归档会话超过该天数后自动清理其总结 |
| 存储与清理 | 立即清理（按钮） | — | 立即删除所有非活跃会话的思考总结（宽限保留最近 24h） |

### 模型池（多模型轮转）

单个免费模型很容易被限流（实测商汤免费额度按分钟限流，并发 >1 就 `429 rpm exhausted`）。
在「精炼模型 → 模型池」里添加多个模型即可：

- **轮转**：分段摘要、整体摘要、任务看板翻译**共用一个池子**，按添加顺序依次取模型；
- **每模型并发**：并发上限是"每个模型几个"，多模型时总并发随模型数放大
  （3 个模型 × 每模型 1 = 总并发 3），不再对着一个模型压；
- **指数退避**：某模型失败后按 2s → 4s → 8s … 递增退避（上限 60s），期间其他模型顶上；
- **换模型重试**：一个任务最多试「换模型重试」轮，每轮可能落到不同模型；
  全部失败才写回错误（错误码直显在卡片上）；
- **自动开关思考（带记忆）**：首次对某模型探测"能不能关思考"，**结论持久化记住**
  （带 `reasoningEffort` 成功过 → 之后每次直接带；被拒绝 → 永不带）。
  每个模型只交一次学费——不带 `reasoningEffort` 的会思考模型实测慢 16~25 倍
  （24.6s vs 1.0s），不能每次都重新试错；
- **低成功率降频**：成功率 <50% 的模型每用一次要冷却一段时间
  （30s × (1+失败率)，封顶 5 分钟；**成功也不清零**），把机会让给高成功率模型；
- **气泡状态色**：按累计成功率上色（**绿** ≥50% / **黄** <50% 但成功过 / **红** 一次没成功过；
  尝试不足 5 次不显示），统计写入 `~/.dsh/dsh-think-summary-pool.json` 跨重启累计。

> 气泡上只显示**模型名**，悬停可看完整的 `供应商/模型` 与成功/失败次数、成功率。
> 挑模型时要**逐个实测**：`/v1/models` 会列出实际打不通的模型（本项目已踩坑两次）。

> **摘要归一化**（0.1.4）：模型返回小作文时只取第一行/第一句、去列表符/编号/标题/前导词，
> 超 60 字符截断；归一化后为空则按精炼失败处理（写回原因、保留启发式摘要）。

> **换供应商要注意的两件事**（0.1.5，详见 [docs/probe-notes.md §8](./docs/probe-notes.md)）：
> 1. **输出上限**：各家对 `max_tokens` 有自己的合法区间。插件现在只在**上限已知**时
>    （供应商块里声明了 `maxTokens`）收敛预算，未声明则保留你的设置值。
>    想让某个供应商稳，就在它的模型条目里写 `maxTokens`。
> 2. **关闭思考**：`off` 档位的语义是"省略 reasoning 字段"，**供应商自己默认思考时等于没关**。
>    要在某供应商上真关掉，需要它的配置里声明
>    `compat.supportsReasoningEffort: true` + 模型 `reasoningEfforts.off: <该家认的关闭值>`
>    （商汤认 `none`；不声明的话插件的"关闭思考"对该模型不生效，因为发了会被 400）。

改动即时生效（阈值/开关在每次流开始时读取），无需重启。

## 使用与验证

1. 向模型提出需要深度推理的问题（超过「长思考阈值」）。
2. 思考进行中，composer 上方出现实时面板：`● 思考中 · N tok · M 段`，分段摘要滚动追加。
3. 思考结束面板转为「思考结束」；下一次思考积累期保留上次总结作为参照。
4. 每条回复末尾出现可折叠的「思考总结」条；会话头部「思考总结」选项卡查看全部历史。
5. 阈值内的短思考不产出分段；代码块/表格在 `ignore` 模式下不显示任何痕迹。

## HTTP 接口（Host 提供，浏览器同源直连）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/think-summary/state?sessionId=` | 会话思考状态视图（sessionId 缺省用最近活跃会话） |
| GET | `/api/think-summary/models` | 精炼供应商/模型下拉数据源 |
| POST | `/api/think-summary/settings/describe` | 设置命名空间视图 |
| POST | `/api/think-summary/settings/mutate` | 逐字段 set/unset（revision 围栏） |
| POST | `/api/think-summary/clear-archived` | 清理已归档会话总结（`{ graceMs? }`） |
| POST | `/api/think-summary/pause` | 切换全局暂停 |
| POST | `/api/think-summary/refine` | 视图页「再试」：重新入队精炼 |

settings / clear-archived / pause / refine 接口为 loopback-only（拒绝非本机来源）。

## 开发

```bash
npm install
npm run build      # tsc 编译 Host + 打包客户端 bundle（lib/client.js）
npm run typecheck
node scripts/seg-check.mjs     # 分段算法回归
node scripts/order-check.mjs   # 客户端 bundle 模块顺序检查
node scripts/refine-check.mjs  # 精炼回归
```

内部设计文档（design / probe-notes / segment-optimization / self-summary-mode）
保留在仓库根 `docs/` 目录，仅贡献者可见，**不随 npm 包发布**。

### 调试循环（改码 → 生效）

```bash
npm run watch:all     # 并行：tsc --watch（Host → lib/）+ 客户端 bundle watch
```

| 改动位置 | 生效方式 |
|---|---|
| `src/client/*.js` | bundle 自动重建后**刷新浏览器**即生效 |
| `src/host/*.ts` | `lib/` 编译后**重启 dsh web** 生效 |

只盯客户端时单独跑 `npm run watch:client`。

### 精炼失败排查

段的「未精炼原因」会写明具体失败原因（`<provider>/<model> error：<code> HTTP <status> <message>`）。
常见原因：

- `PROVIDER_HTTP_ERROR HTTP 404`：`openai-completions` 的 `baseURL` 必须是 OpenAI 兼容根
  （Ollama 是 `http://127.0.0.1:11434/v1`）。
- `未返回文本（finish=max-tokens）：预算被推理耗尽`：把「精炼预算」调大（如 2048），
  或关掉该模型的思考。
- `未注册，已回退主请求 provider`：设置里选的供应商已被卸载/改名，重选即可。
- `摘要不是中文`：模型「接话」了——语言硬校验拒收，段保留启发式摘要并标注原因，
  点「再试」即可。

若段有大小、开关也开着却一直显示「待精炼」，说明宿主里跑的是 0.1.3 之前的代码——
**重启 dsh web** 即可。

## 许可

[MIT](./LICENSE)
