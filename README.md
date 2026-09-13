# dsh-think-summary

> DSH（Cordis 架构）双面插件：**长思考链分段总结** —— 检测模型的长思考，边思考边分段，
> 逐段产出摘要，实时展示在聊天区，附带设置页与历史持久化。

- 版本：`0.1.4`（npm 标签 `v0.1.1` / `v0.1.2`）
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
- **逐段总结**：启发式提取（0 token）即时出；**精炼**用所选供应商的最小可用模型
  （`refineProvider` 默认 `auto` 跟随主请求，可手动指定其他已注册供应商；并发池默认 3、
  超时释放、异常自动回退启发式并标注原因）。
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
| 小模型精炼 | 精炼 | `true` | 所有可精炼分段都用所选供应商的最小模型精炼摘要 |
| 小模型精炼 | 代码块/表格处理 | `ignore` | 忽略 / 保留+跳过精炼 / 保留并精炼 |
| 小模型精炼 | 精炼输入裁剪 | `headtail` | 头尾（保主题+结论）/ 仅尾部 / 完整保留 |
| 小模型精炼 | 精炼输入预算 | `800` | 喂给小模型的段文本预算（token） |
| 小模型精炼 | 精炼预算 | `512` | 精炼 API 完成预算；推理型模型建议 ≥1024 |
| 小模型精炼 | 精炼最小段 | `0` | **0（默认）= 每个段都精炼** |
| 小模型精炼 | 精炼并发 | `3` | 并行精炼数；任务之间互不打断 |
| 小模型精炼 | 精炼超时 | `60` | 单任务超时（秒），卡死任务超时放弃并释放并发位 |
| 小模型精炼 | 精炼供应商 | `auto` | 跟随主请求，或手动指定任一已注册供应商 |
| 小模型精炼 | 精炼模型 | `auto` | 自动选用所选供应商目录中上下文窗口最小的可用模型 |
| 小模型精炼 | 精炼提示词 | 动向摘要模板 | 第一遍（分段）提示词（角色 + 示例 + 硬规则） |
| 小模型精炼 | 整体摘要提示词 | 动向合并模板 | 第二遍：把分段摘要再喂一次模型得到整体动向 |
| 主模型自产小结 | 模式 | `off` | 关闭 / `prompt`（注入提示词并流内捕获【思考小结】） |
| 存储与清理 | 持久化保存 | `true` | 保存到 `~/.dsh/dsh-think-summary.json`，重启后仍可查看 |
| 存储与清理 | 自动清理 | `false` | 定期清理已归档（非活跃）会话的思考总结 |
| 存储与清理 | 归档保留天数 | `30` | 归档会话超过该天数后自动清理其总结 |
| 存储与清理 | 立即清理（按钮） | — | 立即删除所有非活跃会话的思考总结（宽限保留最近 24h） |

> **摘要归一化**（0.1.4）：模型返回小作文时只取第一行/第一句、去列表符/编号/标题/前导词，
> 超 60 字符截断；归一化后为空则按精炼失败处理（写回原因、保留启发式摘要）。

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
