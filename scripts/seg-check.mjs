/**
 * 分段算法开发验证脚本（docs/segment-optimization.md 实现后）：
 *   node scripts/seg-check.mjs
 * 覆盖：围栏内不切、代码块原子、表格整体、有序列表边界、max 句末回溯、
 * 段元数据、ignore 模式（内容不写缓冲 + 元信息段）。
 * 注意：markdown 围栏/列表必须独占行首（真实 LLM 输出如此）——粘在行尾不算围栏。
 * Segmenter 默认 codeMode/tableMode='keep'（库级保守）；stream.ts 按配置传 'ignore'。
 */
import { Segmenter, segmentText } from '../lib/host/segment.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓', name)
  else {
    failed++
    console.log('  ✗ FAIL', name, extra)
  }
}

/** 用流式 Segmenter 喂入若干增量块，收集切出的段。 */
function streamSegments(text, options, sink = null, chunkSize = 7) {
  const out = []
  const seg = new Segmenter(options, (t, tokens, meta, isTail, rawTokens) => out.push({ text: t, tokens, meta, isTail, rawTokens }))
  if (sink) sink(seg)
  for (let i = 0; i < text.length; i += chunkSize) seg.feed(text.slice(i, i + chunkSize))
  seg.flush()
  return out
}

// ---------- 1. 围栏内边界行不误切（流式 + 静态，keep 模式） ----------
console.log('\n[1] 围栏内不切（`- 列表` / `### 标题` / `Step 1` 不应触发切段）')
const fenceProse =
  '开头论述背景与目标，需要足够长的文字来跨越最小窗口。\n' +
  '## 分析开始\n' +
  '继续展开论述，把缓冲推到最小窗口之上，为围栏测试提供真实切点环境。\n' +
  '```js\n- 列表项内容\n### 假标题\nStep 1 假装步骤\nconst x = 1\n```\n' +
  '围栏之后的收尾论述，同样需要足够文字确认切点出现在正确位置，这里补充更多论述内容，说明围栏闭合后的独立段落，确保超过最小尾巴下限不会被丢弃。\n'
const live1 = streamSegments(fenceProse, { segmentMinTokens: 40, segmentMaxTokens: 400 })
const static1 = segmentText(fenceProse, { segmentMinTokens: 40, segmentMaxTokens: 400 })
const fenceIntact = (segs) => {
  for (const s of segs) {
    if (s.text.includes('```js')) {
      const close = (s.text.match(/```/g) || []).length
      if (close < 2) return false
    }
  }
  return true
}
ok('流式：代码块未被切开', fenceIntact(live1))
ok('静态：代码块未被切开', fenceIntact(static1))
ok('流式：围栏两侧有真实切点（段数 ≥2）', live1.length >= 2)
ok('静态：围栏两侧有真实切点（段数 ≥2）', static1.length >= 2)

// ---------- 2. 代码块原子（keep 模式：超 max 不切内部） ----------
console.log('\n[2] 代码块原子与代码段元数据（keep）')
const bigCode =
  '前面是论述段落，交代上下文与目标，需要足够文字支撑一个合理切点，这里再补充一些篇幅，确保散文段在代码块前独立成段。\n' +
  '```ts\n' +
  Array.from({ length: 40 }, (_, i) => `export function fn${i}(a: number): number { return a + ${i} }`).join('\n') +
  '\n```\n' +
  '后面收尾。'.repeat(20) + '\n'
const live2 = streamSegments(bigCode, { segmentMinTokens: 40, segmentMaxTokens: 120 })
const openIdx = live2.findIndex((s) => s.text.includes('```ts'))
const closeIdx = live2.findIndex((s) => s.text.trimEnd().endsWith('```'))
ok('流式：代码段存在（含开围栏）', openIdx >= 0)
ok('流式：代码段存在（含闭围栏）', closeIdx >= 0)
ok('流式：代码块原子（开闭围栏同段，超 max 不切内部）', openIdx >= 0 && openIdx === closeIdx)
ok('流式：代码段 codeRatio 高', openIdx >= 0 && live2[openIdx].meta.codeRatio > 0.5)
ok('流式：代码段前的散文段 codeRatio 低', openIdx > 0 && live2[openIdx - 1].meta.codeRatio < 0.5)

// ---------- 3. 表格整体（不跨行切；isTable 判定） ----------
console.log('\n[3] 表格整体 + isTable 元数据（keep）')
const tableText =
  '表格前的论述段落，用于填充最小窗口，保证切点逻辑被完整走一遍。\n' +
  '| 名称 | 类型 | 说明 |\n| --- | --- | --- |\n' +
  Array.from({ length: 8 }, (_, i) => `| 字段${i} | string | 第 ${i} 个字段说明 |`).join('\n') +
  '\n表格后的收尾论述，同样需要足够长度来验证整体性。\n'
const static3 = segmentText(tableText, { segmentMinTokens: 40, segmentMaxTokens: 120 })
const tableSegs = static3.filter((s) => s.meta.isTable)
ok('静态：存在 isTable 段', tableSegs.length >= 1)
ok('静态：表格段含表头', tableSegs.some((s) => s.text.includes('| 名称 |')))

// ---------- 4. 有序列表 / 任务项边界 ----------
console.log('\n[4] 有序列表与任务项为边界信号')
const orderedText =
  '一段较长的论述文字，用来把缓冲推过最小窗口，接着出现有序列表作为新的逻辑单元，这里再补充一点内容。\n' +
  '1. 第一步要做的事\n2. 第二步要做的事\n3. 第三步要做的事\n' +
  '列表后的补充说明文字。\n'
const static4 = segmentText(orderedText, { segmentMinTokens: 40, segmentMaxTokens: 2000 })
ok('静态：列表边界处有切点（≥2 段）', static4.length >= 2)
if (static4.length >= 2) ok('静态：有序列表项起始新段', /^\s*1\.\s/.test(static4[1].text))

// ---------- 5. max 句末回溯（流式，无换行长句） ----------
console.log('\n[5] max 强制切回退到句末')
const longLine = Array.from({ length: 30 }, (_, i) => `这是第${i}个完整的思考句子，内容围绕方案设计与权衡展开。`).join('')
const live5 = streamSegments(longLine, { segmentMinTokens: 40, segmentMaxTokens: 150 })
ok('流式：长句被切成 ≥2 段', live5.length >= 2)
const endsOk = live5.every((s) => s.text.length === 0 || /[。！？]/.test(s.text.slice(-1)))
ok('流式：每段以句末标点收尾（句末回溯）', endsOk, JSON.stringify(live5.map((s) => s.text.slice(-2))))

// ---------- 6. MIN_SEGMENT_FLOOR = 0：任何短尾巴都出段（本项目要求短思考也要总结） ----------
console.log('\n[6] flush 小尾巴（下限已设为 0，不再丢弃）')
const tiny = streamSegments('短尾巴文本。', { segmentMinTokens: 40, segmentMaxTokens: 400 })
ok('流式：短尾巴也出段', tiny.length === 1, JSON.stringify(tiny.map((s) => s.text)))
ok('流式：短尾巴确实是被精炼门控放行的尾巴段', tiny[0] !== undefined && tiny[0].isTail === true)

// ---------- 7. ignore 模式：代码/表格内容不写缓冲，产出元信息段 ----------
console.log('\n[7] ignore 模式（默认）：内容不写缓冲 + 元信息段')
const ignoreText =
  '散文段落一，需要足够长度跨越最小窗口，用于验证忽略模式下的分段，这里再补充一些内容确保超过下限。\n' +
  '```py\nprint(1)\nprint(2)\n```\n' +
  '散文段落二，继续累积验证元信息段顺序与散文分段，这里补充足够多的文字以确保超过小尾巴下限不被丢弃。\n' +
  '散文段落二补，继续追加内容确保收尾段超过最小下限。\n'
const metas = []
const segs7 = []
const seg7 = new Segmenter(
  { segmentMinTokens: 40, segmentMaxTokens: 400, codeMode: 'ignore', tableMode: 'ignore', onMeta: (info) => metas.push(info) },
  (t, tokens, meta) => segs7.push({ text: t, tokens, meta }),
)
for (let i = 0; i < ignoreText.length; i += 5) seg7.feed(ignoreText.slice(i, i + 5))
seg7.flush()
ok('ignore：产出代码元信息（行数=2、语言=py）', metas.some((m) => m.kind === 'code' && m.lines === 2 && m.lang === 'py'))
ok('ignore：产出段不含代码内容', segs7.every((s) => !s.text.includes('print(')))
ok('ignore：散文段正常切出（≥2 段）', segs7.length >= 2)

const ignoreTable =
  '散文段落，足够长度跨越最小窗口，验证表格忽略。\n' +
  '| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n' +
  '表格后的散文段落继续累积。\n'
const metasT = []
const segsT = []
const segT = new Segmenter(
  { segmentMinTokens: 40, segmentMaxTokens: 400, codeMode: 'ignore', tableMode: 'ignore', onMeta: (info) => metasT.push(info) },
  (t, tokens, meta) => segsT.push({ text: t, tokens, meta }),
)
for (let i = 0; i < ignoreTable.length; i += 5) segT.feed(ignoreTable.slice(i, i + 5))
segT.flush()
ok('ignore：产出表格元信息（行数=4）', metasT.some((m) => m.kind === 'table' && m.lines === 4))
ok('ignore：产出段不含表格内容', segsT.every((s) => !s.text.includes('| a |')))

// ---------- 8. rawTokens：忽略的代码/表格 token 计入原始 token，但段 tokens 不变 ----------
console.log('\n[8] rawTokens 口径（显示用：含被忽略的代码/表格；段 tokens 不变）')
const rawSegs = []
const rawSeg = new Segmenter(
  { segmentMinTokens: 40, segmentMaxTokens: 400, codeMode: 'ignore', tableMode: 'ignore' },
  (t, tokens, meta, isTail, rawTokens) => rawSegs.push({ text: t, tokens, meta, rawTokens }),
)
const rawText =
  '散文开头，需要足够文字跨越最小窗口并形成独立段，这里补充内容确保超过下限，作为代码块之前的独立段落。\n' +
  '```py\n' + 'print(1)\nprint(2)\nprint(3)\n' + '```\n' +
  '代码块之后的散文收尾，继续补充文字确保这一段的原始 token 包含被忽略的代码行内容，这里需要写足够长的一段文字让它超过尾部下限不会被丢弃，再继续补充一些论述文字保证这段的 token 数量明显超过最小尾巴，这样才能验证被忽略的代码行被完整计入原始 token 口径。\n'
for (let i = 0; i < rawText.length; i += 5) rawSeg.feed(rawText.slice(i, i + 5))
rawSeg.flush()
const rawHasCodeSeg = rawSegs.find((s) => s.rawTokens !== undefined && s.rawTokens > s.tokens)
ok('ignore：至少一段 rawTokens > tokens（代码被计入原始 token）', rawHasCodeSeg !== undefined,
  JSON.stringify(rawSegs.map((s) => ({ t: s.tokens, r: s.rawTokens }))))
ok('rawTokens 不减小于段 tokens（口径单调）', rawSegs.every((s) => (s.rawTokens ?? s.tokens) >= s.tokens))

// ---------- 9. 兜底路径（segmentText）：无 ignore，rawTokens 未设置 ----------
console.log('\n[9] 兜底路径（segmentText 静态）不产出 rawTokens（客户端回退段 tokens）')
const fallbackSegs = segmentText(rawText, { segmentMinTokens: 40, segmentMaxTokens: 400 })
ok('静态段无 rawTokens 字段', fallbackSegs.every((s) => !('rawTokens' in s)))

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
