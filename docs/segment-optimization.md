# 分段算法分析与优化方案（v0.2 设计稿）

> 目标：1) 分块更有逻辑；2) 更省 token。
> 方法：Markdown 结构感知分段（代码块原子、列表/表格整体保留）+ 切点质量增强 + 精炼价值过滤。
> 状态：**已实施**（v0.2）。用户决策：代码块原子保留+默认跳过精炼；表格整表原子+结构化摘要；
> 跳过默认开；A+B+C 全做；精炼输入裁剪三档可配置（headtail/tail/full）。
> 回归验证：`node scripts/seg-check.mjs` 全部通过。

## 一、现状算法拆解

数据流：`llm/stream` 包裹 → `ThinkingDetector`（累计 token，阈值 2000 进入分段）→ `Segmenter`（增量缓冲）→ `heuristicSummary`（0 token）→ `RefineQueue`（小模型精炼，~0.85k token/段）。

Segmenter 关键机制（`src/host/segment.ts`）：

1. **双阈值**：tokens ≥ segmentMin(1500) 后可切（等语义边界），≥ segmentMax(3000) 强制切
2. **语义边界** `STRONG_BOUNDARY`（m 标志、行首锚定）：标题、无序列表项、结构词（接下来/其次/然后/之后/最后/总之/综上/Finally/Secondly/Thirdly/Next,/Now,/Step N）、代码围栏闭合 ` ```\s*$ `
3. **canCut 门控** = detector.inSplice：阈值前缓冲保留，首个切段包含阈值前文本（不整体丢弃）
4. **tailFrom 优化**：只测最近尾部（自上一个 \n 起），避免命中缓冲中陈旧的边界信号
5. **flush 兜底**：流结束 ≥ MIN_SEGMENT_FLOOR(64) 才出段；段哈希去重（层内 lastHash + state 级 hashes）
6. **静态路径** `segmentText`：同规则 + `splitLongLine`（超长行按句末标点拆子行）

## 二、问题清单（按影响排序）

| # | 严重度 | 问题 | 位置 | 后果 |
|---|--------|------|------|------|
| P1 | 高 | **代码围栏不可感知**：围栏**内**的 `- 列表`、`### 标题`、`Step 1` 等行会误触 STRONG_BOUNDARY；长代码块被 max 从中间切 | segment.ts:35,81 | 假切段、半截代码段；启发式摘要无意义；精炼 token 白花 |
| P2 | 高 | **max 强制切是任意位置**：切点落在 feed 边界（词/句中任意处），无回溯到句末/行末 | segment.ts:81 | 段首段尾语义断裂，摘要质量差 |
| P3 | 中 | **边界信号不全**：有序列表 `1. `、任务项 `- [ ]`、引用 `>`、分隔线 `---` 都不是边界；标题不分层级（`####` 与 `#` 同权重） | segment.ts:34-35 | 该切时没切，段内混杂多个逻辑单元 |
| P4 | 中 | **表格无保护**：长表格被 max 从行中间切（表头/分隔行被拆散） | segment.ts:81 | 半截表格段，摘要无意义 |
| P5 | 中 | **精炼无价值过滤**：纯代码段/表格段也精炼（每段 ~0.85k token） | refine.ts enqueue | 纯代码段精炼结果基本是浪费 |
| P6 | 低 | **精炼输入只保尾部**：trimToTokens 丢头部（主题通常在前 ~20%） | refine.ts:66-72 | 摘要信息量/成本比可改进 |
| P7 | 低 | 代码类段启发式摘要是空转（无标题/结论可提取）；围栏闭合跨增量拆分（"``"+"`\n"）可能漏边界；计数器把 markdown 标点也按 token 计（略高估→略早切） | heuristic.ts / segment.ts | 显示质量、边界鲁棒性、切点精度 |

## 三、资料调研要点

通用原则（多来源收敛）：

1. **边界优先级**：块级结构（标题/代码/表格）> 列表项 > 句子 > 硬切 —— LangChain `RecursiveCharacterTextSplitter` 的分隔符优先级思想：先按最高级结构切，逐级降级，最后才硬切字符。
   - https://python.langchain.com/docs/how_to/recursive_text_splitter/
   - https://python.langchain.com/docs/how_to/markdown_header_metadata_splitter/
   - https://reference.langchain.com/python/langchain-text-splitters/markdown
2. **原子单元**：代码围栏、表格、列表（整块或仅按项/行边界切）—— The Neural Base "Navigation chunks"（结构先行的分段，把标题/列表/表格当作不可拆的导航单元）；structchunk（围栏感知 markdown 分段库）。
   - https://theneuralbase.com/chunking-strategies/learn/advanced/navigation-chunks-for-structure/
   - https://socket.dev/pypi/package/structchunk/overview/0.1.0#1
3. **按块类型分类处理**：结构化文档先按块类型（标题/段落/表格/代码）分类再分别处理 —— 腾讯 WeKnora CHUNKING 文档。
   - https://raw.githubusercontent.com/Tencent/WeKnora/main/docs/CHUNKING.md
4. **结构键/上下文继承**：子块继承父标题上下文 —— MDKeyChunker（RAG 方向，仅借鉴"结构键"概念；不引入 LLM 分段——省 token）。
   - https://www.semanticscholar.org/paper/MDKeyChunker%3A-Single-Call-LLM-Enrichment-with-Keys-Mangla/6d472284ff24bf1616477537c780a415cabaffc1
5. 段落边界回溯：宁可多留一点，不在句中/词中切。

## 四、优化方案

### A. Markdown 结构感知（分块更有逻辑）⭐核心

新增 `src/host/mdline.ts`：轻量**行分类器 + 围栏状态机**（regex，流式安全，O(行)）：

- `kind`：`fence-open` / `fence-close` / `code`（围栏内）/ `heading`（含层级）/ `bullet`（无序）/ `ordered`（有序）/ `task`（任务项）/ `quote` / `table`（含 `|`）/ `table-sep`（`|---|`）/ `hr` / `blank` / `text`
- Segmenter 持有 fence 状态（open/close 计数，支持 ` ``` ` 与 `~~~`）：
  - **围栏内**：不做任何边界测试（消除 P1 假切）；若 max 超限，在**围栏边界**处切——整个代码块为一个原子段
  - **表格**：整表原子；超限只在**行边界**切（表头+分隔行必须同段）
  - **列表**：只在**项边界**切（扩展到有序列表 `1. ` 与任务项 `- [ ]`）；连续项整体优先
- 静态 `segmentText` 复用同一分类器（同规则）

### B. 切点质量增强（P2/P3）

- **回溯切点**：max 触发时在 `[minAnchor, 当前位置]` 找最近句末（。！？!?.；）或行末；无则硬切（对齐 splitLongLine 的拆行逻辑）
- **边界信号扩展**：`\d+[.、)]\s`（有序）、`[-*+]\s\[\s?x?\]\s`（任务）、`>\s`（引用）、`^---+$`（hr）
- **标题按层级权重**：`#{1,2}` 强边界（达 min 即切）；`#{4,6}` 弱边界（仅当段内已有更高级标题时切，或仅作候选）
- 围栏闭合保留为强边界（思考从代码回到论述的天然分段点）

### C. 省 token（P5/P6）⭐

1. **代码段跳过精炼**（配置 `refineSkipCode`，默认开）：段内围栏字符占比 > 阈值（默认 50%）→ 启发式摘要改为"代码块 · ≈N 行 · <首行>"，不入精炼队列；state 标记 `refined: 'skipped'`，UI 显示"代码段·未精炼"（不再歧义）
2. **表格结构化摘要**：纯表格段 → "表：<列头> · N 行 · 首行 …"，0 token，不精炼
3. **头尾裁剪**：`trimToTokens` → `headTailTrim`（保头 ~30% + 尾 ~70%，同预算下摘要信息量更高）。**三档可配置**：`refineTrim` = `'headtail'`（默认，保头+尾、丢中段）/ `'tail'`（仅保尾部，中段细节不丢但主题可能丢失）/ `'full'`（完整保留不裁剪，信息最全、最耗 token），供用户权衡信息损失
4. **非推理模型优先**（可选）：`resolveModel` 时若 provider 有非推理小模型，精炼优先选它（无隐藏推理；outputTokens 可从 1024 降到 256）
5. 段更大更整 → 段数更少 → 精炼调用更少（结构性分段的自然收益）

### 新增配置项（v0.2）

| 键 | 默认 | 说明 |
|---|---|---|
| `refineSkipCode` | true | 纯代码段不调小模型精炼（结构化摘要 0 token 兜底，UI 标"代码段·未精炼"） |
| `refineTrim` | 'headtail' | 精炼输入裁剪策略：头尾 / 仅尾部 / 完整保留 |

### D. 流式健壮性（P7）

- 围栏状态机（A 自带）
- **lookback 一行**：feed 结束若新文本以 `\n` 结尾，重测刚完成的上一行（防 `"``"+"`\n"` 漏边界）
- 计数器不计纯标点/空白（可选微调）

## 五、效果估算

- 代码占比高的思考（约 40% 代码）：精炼调用减 30~40% → 1 次 20k token 思考链从 ~8-13 次精炼降到 ~5-8 次（~4-7k token 总成本）
- 无代码思考：段更大更整（减少 max 硬切造成的冗余段）→ 略减
- 头尾裁剪 + 非推理模型（若可用）：每段再省 30-60%

## 六、待确认决策项

1. 代码块"忽略"的确切含义：原子保留+跳过精炼（推荐） / 原子保留+仍精炼 / 完全剔除
2. 表格处理：整表原子+结构化摘要（推荐） / 允许按行边界切
3. 代码段跳过精炼默认值：开（省 token，推荐） / 关（全量精炼）
4. 实现范围：A+B+C 全做（推荐） / 先 A 后 C / 只 A

## 七、风险与边界

- 流式下"表格/列表整体"是软保证（受 max 限制），超限按项/行边界切
- 行分类 regex 成本 O(行)，可忽略；不改 chunk 流、不阻塞主请求（现有架构不变）
- 全部为 host 改动，客户端无感；需重启 dsh 生效
