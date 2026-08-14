/**
 * M2 启发式总结提取器（0 token，design.md §4.3.1）：
 * 抽主题句/标题/结论句/要点行，并附文件路径与高频代码标识符（过滤停用词）。
 * 每段先截断再拼接，保证文件/符号后缀存活于 maxLen 内。
 */

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
