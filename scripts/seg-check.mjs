/**
 * 分段算法开发验证脚本（docs/segment-optimization.md 实现后）：
 *   node scripts/seg-check.mjs
 * 覆盖：围栏内不切、代码块原子、表格整体、有序列表边界、max 句末回溯、段元数据。
 * 注意：markdown 围栏/列表必须独占行首（真实 LLM 输出如此）——粘在行尾不算围栏。
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
function streamSegments(text, options, chunkSize = 7) {
  const out = []
  const seg = new Segmenter(options, (t, tokens, meta) => out.push({ text: t, tokens, meta }))
  for (let i = 0; i < text.length; i += chunkSize) seg.feed(text.slice(i, i + chunkSize))
  seg.flush()
  return out
}

// ---------- 1. 围栏内边界行不误切（流式 + 静态） ----------
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
  // 含 ```js 的段必须同时含闭合 ```，即代码块未被从中间切开
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

// ---------- 2. 代码块原子（超大代码块：围栏边界切，代码段不混散文） ----------
console.log('\n[2] 代码块原子与代码段元数据')
const bigCode =
  '前面是论述段落，交代上下文与目标，需要足够文字支撑一个合理切点。\n' +
  '```ts\n' +
  Array.from({ length: 40 }, (_, i) => `export function fn${i}(a: number): number { return a + ${i} }`).join('\n') +
  '\n```\n' +
  '后面收尾。'.repeat(20) + '\n'
const live2 = streamSegments(bigCode, { segmentMinTokens: 40, segmentMaxTokens: 120 })
const openIdx = live2.findIndex((s) => s.text.includes('```ts'))
const closeIdx = live2.findIndex((s) => s.text.trimEnd().endsWith('```'))
ok('流式：代码段存在（含开围栏）', openIdx >= 0)
ok('流式：代码段存在（含闭围栏）', closeIdx >= 0)
ok('流式：代码段之间不混散文（均 codeRatio 高）', openIdx >= 0 && closeIdx >= 0 && live2.slice(openIdx, closeIdx + 1).every((s) => s.meta.codeRatio > 0.5))
ok('流式：代码段前的散文段 codeRatio 低', openIdx > 0 && live2[openIdx - 1].meta.codeRatio < 0.5)

// ---------- 3. 表格整体（不跨行切；isTable 判定） ----------
console.log('\n[3] 表格整体 + isTable 元数据')
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

// ---------- 6. MIN_SEGMENT_FLOOR：小尾巴不出段 ----------
console.log('\n[6] flush 小尾巴下限')
const tiny = streamSegments('短尾巴文本。', { segmentMinTokens: 40, segmentMaxTokens: 400 })
ok('流式：低于下限的尾巴不出段', tiny.length === 0)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
