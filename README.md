# dsh-think-summary

> DSH（Cordis 架构）插件：**长思考链分段总结** —— 检测模型的长思考，边思考边分段，
> 逐段产出摘要并实时展示在聊天区，附带设置页。

- 详细设计：[`docs/design.md`](./docs/design.md)
- 运行时探测结论：[`docs/probe-notes.md`](./docs/probe-notes.md)
- 分段算法优化设计：[`docs/segment-optimization.md`](./docs/segment-optimization.md)

---

## 特性

- **长思考检测**：`llm/stream` 瀑布实时观察 `reasoning-delta`，轻量 token 计数
  （CJK 自适应、原始计数不取整），超过阈值自动进入分段模式；无 sessionId 的
  旁路流（子代理 / 标题生成）自动过滤。
- **语义分段**：双阈值（最小窗口 1500 / 硬上限 3000 token）+ **Markdown 结构感知**
  （围栏状态机——代码块整体原子、围栏内不误切；表格整体保留；列表按项边界切；
  有序列表/任务项/引用/分隔线边界；max 强制切回溯到最近句末/行末；`blockType`
  切换强信号），只缓存未总结余量，内存有界、state 级去重。
- **代码块/表格三态处理**：`ignore`（默认，内容不写内存、不计段 token、不精炼，
  总结卡片**不显示**任何代码块/表格痕迹）/ `keep-skip`（保留+结构化
  摘要、跳过精炼）/ `keep-refine`（保留并精炼）；总思考 token（阈值/进度）始终
  计入代码量。
- **逐段总结**：启发式提取（0 token）即时出；**精炼**用会话 provider 的最小模型
  精炼可精炼段（输入裁剪三档：头尾 / 仅尾部 / 完整保留；展示截断 ~60 token；
  并发 1；异常自动回退启发式；主流异常时按 (会话, think) 精确取消）；段头同时
  显示**原始输出 token** 与**精炼实际 token**（输入裁剪后 + 输出摘要）。
- **实时展示**：聊天区 composer 上方实时面板（思考进度 + 滚动分段摘要，仅"对话"
  视图显示），客户端轮询 `/api/think-summary/state`；总结**不写回会话上下文**，零污染。
- **思考总结视图**：会话头部新增"思考总结"选项卡，列出当前会话**全部**被记录的
  思考（每段摘要 + 原始/精炼双 token + 状态），可折叠。
- **事后兜底**：`session/event` 事件流断流/异常时补跑分段总结，不丢摘要。
- **设置页**：官方插件配置区卡片（自建 loopback 设置桥），改动即时生效。

## 安装（多路通用）

同时兼容 **DSH web profile 插件机制**（Host + 浏览器双面）与 **纯 Cordis 装载**（仅 Host 面）。

### 方式一：本地开发（符号链接 + 自动补丁）⭐

```bash
dsh plugin --profile web add link:/path/to/dsh-think-summary
# 卸载
dsh plugin --profile web remove dsh-think-summary
```

等价于在 `~/.dsh/profiles/web/node_modules/` 建立符号链接并应用 `cordis.patch.yml`
（由 `package.json` 的 `dsh.bundle.patch` 声明）。浏览器客户端经 `dsh.client` 声明
装载于 `/plugins/dsh-think-summary/client.js`。

### 方式二：npm 包（发布后）

```bash
npm publish            # 或私有 registry
dsh plugin --profile web add dsh-think-summary
```

### 方式三：手动 cordis.yml 行（仅 Host 面，无浏览器 UI）

```yaml
- path: /path/to/dsh-think-summary   # 本地路径
# 或
- pkg: dsh-think-summary             # npm 包名
```

此方式只装载 Host 面（检测 / 分段 / 总结 / 精炼均可用），无设置页与实时面板。

### 方式四：手动 web profile 补丁（不依赖 CLI）

1. 把包链接进 profile：`npm install -D dsh-think-summary`（或在
   `~/.dsh/profiles/web/node_modules/` 下建立符号链接）；
2. 编辑 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: think-summary
      name: 'dsh-think-summary'
```

## 设置

侧边栏 设置 → 插件配置 → think-summary 卡片：

| 字段 | 默认 | 说明 |
|---|---|---|
| 启用 | `true` | 总开关 |
| 长思考阈值 | `2000` | thinking tokens 超过即判定长思考并开始分段 |
| 段最小窗口 | `1500` | 达到后可切（等待语义边界信号） |
| 段硬上限 | `3000` | 到点强制切（回溯到最近句末/行末），保证缓冲有界 |
| 精炼 | `true` | 开启后所有**可精炼**分段都用会话 provider 最小模型精炼摘要 |
| 代码块处理 | `ignore` | 忽略（内容不写内存、不精炼，卡片不显示）/ 保留+跳过精炼 / 保留并精炼 |
| 表格处理 | `ignore` | 同上 |
| 精炼输入裁剪 | `headtail` | 精炼输入裁剪：头尾（保主题+结论、丢中段）/ 仅尾部 / 完整保留（不裁剪） |
| 精炼预算 | `1024` | 精炼 API 完成预算（推理 + 答案） |
| 精炼模型 | `auto` | `'auto'` = 最小可用模型；可显式指定 |

改动即时生效（阈值在每次流开始时读取），无需重启。

## 使用与验证

1. 触发长思考：向模型提出需要深度推理的问题（超过 `长思考阈值`）。
2. 思考进行中，composer 上方出现实时面板：`● 思考中 · N tok · M 段`，
   分段摘要滚动追加；开启精炼的段稍后标记"已精炼"。
3. 思考结束面板转为"思考结束"并保留最近 8 段。
4. 面板只在判定为长思考后出现，短思考不打扰。

## 架构速览

```
模型流 ─► llm/stream 包裹（检测+分段+启发式总结+精炼入队）──► state（会话级）
                                                                  │
session/event 兜底补跑 ◄──────────────────────────────┐          │
                                                      ▼          ▼
   客户端：settings.plugin.item 设置卡片 ◄─ loopback 设置桥 ─ /api/think-summary/*
   客户端：conversation.input.dock 实时面板 ◄── 轮询 ── /api/think-summary/state
```

## 开发

```bash
npm install
npm run build      # tsc 编译 Host + 打包客户端 bundle（lib/client.js）
npm run typecheck
node scripts/seg-check.mjs   # 分段算法回归（围栏原子/表格整体/句末回溯/元数据）
```

> 客户端 bundle 由宿主实时读取（改后刷新浏览器即生效）；Host 半面改动需重启 dsh。

### 部署要点（实测确认）

官方设置桥（dsh-host-apiproxy）只把白名单命名空间服务给浏览器，web-ui 组的桥接
（`/api/dsh-web-ui-settings`）也只认家族插件清单 —— **独立第三方插件的设置卡片
必须自建 loopback 设置桥**。本插件已实现：`POST /api/think-summary/settings/describe|mutate`
（宿主直连 settings 服务、revision 围栏），客户端用迷你 scope 控制器读写，不依赖
web-ui 组。完整调查过程见 `docs/probe-notes.md` §6。

## 里程碑

- [x] **M1** 探测 + 骨架（运行时探测确认 StreamChunk 形状 / 会话归属）
- [x] **M2** 分段 + 启发式总结 + 事后兜底（审查驱动的修复；实机 + 合成验证）
- [x] **M3** 小模型精炼（请求契约实机确认；实测 ~0.85k token/次）
- [x] **M4** 发布打磨（多安装方式 + 设置页 + 构建脚本 + 部署排查）

## 许可

[MIT](./LICENSE)
