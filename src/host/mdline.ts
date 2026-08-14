/**
 * Markdown 结构感知（docs/segment-optimization.md §4.A）：
 *  - 行分类器 + 围栏状态机（流式安全）：围栏内不做边界测试，
 *    代码块整体为原子段（max 超限只在围栏边界/行边界切）；
 *    表格为原子单元（表头+分隔行+行整体，max 超限只在行边界切）；
 *    列表只在项边界切（扩展到有序列表/任务项）
 *  - 段元数据：codeRatio（围栏内字符占比）、isTable（表格行占比），
 *    供"跳过代码段/表格段精炼"决策（省 token，§4.C）
 */

/** 围栏行（``` 或 ~~~），行首锚定。 */
export const FENCE_RE = /^\s{0,3}(```|~~~)/

/** 结构词边界（行首锚定；在行内出现不算）。 */
export const STRUCTURE_WORD_RE =
  /^(?:接下来|其次|然后|之后|最后|总之|综上|Finally|Second(?:ly)?|Third(?:ly)?|Next,?|Now,?|Step\s+\d+)/i

const HEADING_RE = /^\s{0,3}(#{1,6})\s+/
const TASK_RE = /^\s{0,3}[-*+]\s+\[[ xX]\]\s+/
const BULLET_RE = /^\s{0,3}[-*+]\s+/
const ORDERED_RE = /^\s{0,3}\d{1,3}[.、)]\s+/
const QUOTE_RE = /^\s{0,3}>\s?/
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_SEP_RE = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/

export type MdKind =
  | 'fence-open'
  | 'fence-close'
  | 'code'
  | 'heading'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'table'
  | 'table-sep'
  | 'hr'
  | 'blank'
  | 'text'

export interface MdLine {
  kind: MdKind
  /** heading 层级（1-6），其余为 0。 */
  level: number
}

/** 单行分类（fence 状态由调用方维护）。 */
export function classifyLine(line: string, inFence: boolean): MdLine {
  if (inFence) {
    return FENCE_RE.test(line) ? { kind: 'fence-close', level: 0 } : { kind: 'code', level: 0 }
  }
  const h = HEADING_RE.exec(line)
  if (h) return { kind: 'heading', level: (h[1] ?? '').length }
  if (FENCE_RE.test(line)) return { kind: 'fence-open', level: 0 }
  if (TASK_RE.test(line)) return { kind: 'task', level: 0 }
  if (BULLET_RE.test(line)) return { kind: 'bullet', level: 0 }
  if (ORDERED_RE.test(line)) return { kind: 'ordered', level: 0 }
  if (QUOTE_RE.test(line)) return { kind: 'quote', level: 0 }
  if (HR_RE.test(line)) return { kind: 'hr', level: 0 }
  if (TABLE_SEP_RE.test(line)) return { kind: 'table-sep', level: 0 }
  if (line.includes('|')) return { kind: 'table', level: 0 }
  if (/^\s*$/.test(line)) return { kind: 'blank', level: 0 }
  return { kind: 'text', level: 0 }
}

/** 该 kind 是否为"切在行前"的边界信号（表格/代码行不算；围栏闭合单独处理）。 */
export function isBoundaryKind(kind: MdKind): boolean {
  return kind === 'heading' || kind === 'bullet' || kind === 'ordered' || kind === 'task' || kind === 'quote' || kind === 'hr'
}

/** 行首结构词边界（text 行命中也算）。 */
export function isBoundaryLine(kind: MdKind, line: string): boolean {
  if (isBoundaryKind(kind)) return true
  return kind === 'text' && STRUCTURE_WORD_RE.test(line)
}

/** 代码段判定阈值：段内围栏字符占比超过此值即视为代码段（跳过精炼）。 */
export const SKIP_CODE_RATIO = 0.5

export interface SegmentMeta {
  /** 围栏内字符 / 非空白字符。 */
  codeRatio: number
  /** 表格行（含分隔行）占比 ≥ 0.5。 */
  isTable: boolean
  /** 段总行数。 */
  lines: number
}

/**
 * 段元数据分析（切段时对段文本扫一次，O(段长)）。
 * startInFence：段**起始**是否已在围栏内（max 把代码块切分后，碎片不含开围栏行，
 * 必须由调用方把围栏状态种子传进来，否则 codeRatio 会被算成 0）。
 */
export function analyzeMeta(text: string, startInFence = false): SegmentMeta {
  let fence = startInFence
  let codeChars = 0
  let tableLines = 0
  let lines = 0
  for (const line of text.split('\n')) {
    lines++
    const kind = classifyLine(line, fence).kind
    if (kind === 'fence-open') fence = true
    else if (kind === 'fence-close') fence = false
    else if (kind === 'code') codeChars += nonWs(line).length
    else if (kind === 'table' || kind === 'table-sep') tableLines++
  }
  const nonBlank = nonWs(text).length
  return {
    codeRatio: nonBlank > 0 ? codeChars / nonBlank : 0,
    isTable: lines > 0 && tableLines / lines >= 0.5,
    lines,
  }
}

function nonWs(s: string): string {
  return s.replace(/\s/g, '')
}
