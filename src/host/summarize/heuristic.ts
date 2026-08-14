/**
 * M2 启发式总结提取器（0 token，design.md §4.3.1）：
 * 抽主题句/标题/结论句/要点行，并附文件路径与高频代码标识符（过滤停用词）。
 * 每段先截断再拼接，保证文件/符号后缀存活于 maxLen 内。
 *
 * docs/segment-optimization.md §4.C：代码块/表格段改用结构化摘要（0 token），
 * 并默认跳过小模型精炼（省 token）。统一入口 summarizeSegment()。
 */
import { SKIP_CODE_RATIO, type SegmentMeta } from '../mdline.js'

const HEADING_RE = /^\s{0,3}#{1,6}\s+/
const BULLET_RE = /^\s*[-*+]\s+/
const CONCLUSION_RE = /(因此|所以|总之|综上|结论|关键|重点|Thus|Therefore|In conclusion|Bottom line|Key point)/i
const FILE_PATH_RE = /(?:[A-Za-z]:\\[^\s"'<>|]+|(?:\/[\w.-]+)+\.[\w]{1,10})/g
const IDENT_RE = /\b[a-z][a-zA-Z0-9_]{2,}\b/g

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'have', 'will', 'would', 'should', 'need',
  'can', 'but', 'not', 'are', 'was', 'has', 'had', 'there', 'their', 'then', 'which', 'what',
  'when', 'where', 'how', 'your', 'you', 'our', 'all', 'one', 'two', 'also', 'very', 'just',
  'about', 'into', 'them', 'they', 'been', 'being', 'were', 'does', 'did', 'doing', 'make',
  'made', 'take', 'took', 'get', 'got', 'let', 'some', 'any', 'more', 'most', 'other', 'only',
  'than', 'over', 'under', 'while', 'after', 'before', 'between', 'during', 'through', 'each',
  'both', 'few', 'many', 'much', 'such', 'these', 'those', 'because', 'since', 'although',
  'though', 'else', 'either', 'neither', 'nor', 'well', 'right', 'now', 'next', 'first',
  'second', 'third', 'last', 'finally', 'important', 'necessary', 'possible', 'really', 'quite',
  'yes', 'okay', 'ok', 'here', 'there', 'back', 'out', 'off', 'down', 'up', 'again', 'same',
])

export function heuristicSummary(text: string, maxLen = 160): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const parts: string[] = []
  const push = (s: string, cap = 120) => {
    const t = s.trim()
    if (t && t.length > 2 && !parts.includes(t)) parts.push(t.length > cap ? t.slice(0, cap) + '…' : t)
  }

  // 1) 标题行（去掉井号）
  for (const l of lines) if (HEADING_RE.test(l)) push(l.replace(HEADING_RE, ''), 80)
  // 2) 结论句（带"因此/结论"等信号）
  for (const l of lines) if (CONCLUSION_RE.test(l)) push(l)
  // 3) 要点行
  for (const l of lines) if (BULLET_RE.test(l)) push(l.replace(BULLET_RE, '• '))
  // 4) 首行（主题候选）
  push(lines[0] || '')
  // 5) 文件路径
  const paths = new Set<string>()
  for (const m of text.matchAll(FILE_PATH_RE)) paths.add(m[0])
  // 6) 高频代码标识符（过滤停用词）
  const idents = new Map<string, number>()
  for (const m of text.matchAll(IDENT_RE)) {
    const w = m[0]
    if (!STOPWORDS.has(w)) idents.set(w, (idents.get(w) ?? 0) + 1)
  }
  const topIdents = [...idents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k)

  let out = parts.join('；')
  if (paths.size > 0) out += ` | 文件: ${[...paths].slice(0, 3).join(', ')}`
  if (topIdents.length > 0) out += ` | 符号: ${topIdents.join(', ')}`
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out
}

/** 代码块摘要（0 token）：语言 + 行数 + 首行实质内容。 */
export function codeBlockSummary(text: string, maxLen = 160): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const first = lines[0] || ''
  const lang = /^\s{0,3}(?:```|~~~)\s*([\w+-]*)/.exec(first)?.[1] ?? ''
  const codeLines = lines.filter((l) => !/^\s{0,3}(?:```|~~~)/.test(l))
  const sample = codeLines.find((l) => l.length > 3) ?? ''
  let out = '代码块 · ' + (lang ? lang + ' · ' : '') + '约 ' + codeLines.length + ' 行'
  if (sample) out += ' | ' + sample.slice(0, Math.max(20, maxLen - out.length - 3)) + '…'
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out
}

/** 表格摘要（0 token）：列头 + 行数。 */
export function tableSummary(text: string, maxLen = 160): string {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l.includes('|'))
  const head = rows[0] ?? ''
  const cells = head.split('|').map((c) => c.trim()).filter(Boolean)
  let out = '表格 · ' + rows.length + ' 行'
  if (cells.length > 0) out += ' · 列: ' + cells.join('/')
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out
}

export interface SegmentSummaryChoice {
  summary: string
  /** 'code'/'table' = 该段不调小模型精炼（结构化摘要已足够，省 token）。 */
  skipReason?: 'code' | 'table'
}

/**
 * 统一段摘要决策（0 token）：
 *  - 表格段（非代码）→ 结构化摘要；skipTable=true 时跳过精炼
 *  - 代码段（围栏字符占比 > SKIP_CODE_RATIO）→ 结构化摘要；skipCode=true 时跳过精炼
 *  - 其余 → 启发式提取
 */
export function summarizeSegment(
  text: string,
  meta: SegmentMeta | undefined,
  skip: { skipCode: boolean; skipTable: boolean },
): SegmentSummaryChoice {
  const codeRatio = meta?.codeRatio ?? 0
  const isTable = meta?.isTable === true
  if (isTable && codeRatio <= SKIP_CODE_RATIO) {
    return skip.skipTable ? { summary: tableSummary(text), skipReason: 'table' } : { summary: tableSummary(text) }
  }
  if (codeRatio > SKIP_CODE_RATIO) {
    return { summary: codeBlockSummary(text), ...(skip.skipCode ? { skipReason: 'code' } : {}) }
  }
  return { summary: heuristicSummary(text) }
}
