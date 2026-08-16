/**
 * M2 分段模块（docs/segment-optimization.md §4）——行级流式分段。
 *
 * 文本按**完整行**处理（未完成行存 pending，O(行)），解决增量任意切分下
 * "行类型判定"与"忽略区内容不写缓冲"两个问题。
 *
 * Markdown 结构感知（mdline.ts）按 mode 处理代码块/表格：
 *  - 'ignore'（默认）：围栏内/表格行内容**不写进缓冲**（不占内存、不计段 token、
 *    不精炼），只在围栏闭/表格结束时经 onMeta 产出极简元信息段
 *    （"代码块 · N 行 · 语言" / "表格 · N 行"）；检测器仍计入总 token（阈值/进度）
 *  - 'keep'：内容保留（原子，永不因 max 在代码/表格内部切），代码段/表格段
 *    独立成段（meta 标记 codeRatio/isTable，供精炼决策）
 *
 * 切点：双阈值（min 后可切，等边界信号；max 强制切，回溯最近句末/行末）；
 * 边界信号切在行前（边界行进下一段）；canCut 门控保留阈值前缓冲；
 * flush 兜底（< MIN_SEGMENT_FLOOR 丢弃）；段哈希去重（层内 + state 级）。
 */
import { countRaw, estimateTokens, type RawCount } from './detect.js'
import { FENCE_RE, classifyLine, isBoundaryLine, analyzeMeta, type SegmentMeta } from './mdline.js'

export interface SegmentOptions {
  segmentMinTokens?: number
  segmentMaxTokens?: number
  /**
   * 切段门控：返回 false 时不切（继续缓冲）。用于"阈值后才开始分段"——
   * 阈值前的缓冲会保留，首个切段包含阈值前的思考文本（不再整体丢弃）。
   */
  canCut?: () => boolean
  /** 代码块处理：'ignore' 内容不写缓冲（onMeta 元信息段）；'keep' 内容保留原子成段。默认 'keep'（库级保守）。 */
  codeMode?: 'ignore' | 'keep'
  /** 表格处理：同 codeMode。 */
  tableMode?: 'ignore' | 'keep'
  /** ignore 模式：围栏闭/表格结束时产出元信息段（0 token、O(1) 内存）。 */
  onMeta?: (info: { kind: 'code' | 'table'; lines: number; lang?: string }) => void
}

export interface SegmentSink {
  /**
   * @param rawTokens 该段对应的**原始 token**（含 ignore 模式下被忽略的代码/表格
   * token + 精炼输入裁剪前的完整段文本 token）；无忽略内容时等于 tokens。
   */
  onSegment(text: string, tokens: number, meta: SegmentMeta, isTail?: boolean, rawTokens?: number): void
}

export interface SegmentPiece {
  text: string
  tokens: number
  meta: SegmentMeta
}

/** flush 时小尾巴下限（token）：低于此值不产出段（design §5 硬规则④）。 */
export const MIN_SEGMENT_FLOOR = 64

/** 哈希去重（FNV-1a 简化）。 */
export function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** 未完成行缓冲的 token 拆分阈值：估算 token 超过此值（max 一半）且非围栏/表格行时按句末标点拆出前部句子。 */
function pendingSplitTokens(max: number): number {
  return Math.max(64, max * 0.5)
}

/** max 回溯窗口（字符）：在最近窗口内找句末/行末，避免回溯过深。 */
const MAX_LOOKBACK = 6000

export class Segmenter {
  /** 已确认的段内容（散文/保留的代码/表格行），行尾 \n。 */
  private buf = ''
  private cjk = 0
  private other = 0
  /** 未完成行（跨增量拼装，O(行)）。 */
  private pending = ''
  /** pending 的原始计数缓存（O(1) 维护，避免拆句循环里反复全量估算）。 */
  private pendingCjk = 0
  private pendingOther = 0
  private readonly min: number
  private readonly max: number
  private readonly canCut: (() => boolean) | undefined
  private readonly emit: (text: string, tokens: number, meta: SegmentMeta, isTail?: boolean, rawTokens?: number) => void
  private readonly onMeta: ((info: { kind: 'code' | 'table'; lines: number; lang?: string }) => void) | undefined
  private readonly codeMode: 'ignore' | 'keep'
  private readonly tableMode: 'ignore' | 'keep'
  private lastHash = ''
  /** ignore 模式状态：当前忽略区类型。 */
  private ignore: 'none' | 'fence' | 'table' = 'none'
  private metaLines = 0
  private metaLang = ''
  /** ignore 模式：当前忽略区累计的 token（代码/表格内容 token，未写缓冲但计入原始 token）。 */
  private ignoreTokens = 0
  /** ignore 模式：已结束忽略区的 token（待并入下一个切段的原始 token）。 */
  private pendingIgnoreTokens = 0
  /** keep 模式状态：当前是否在代码/表格块内（内容保留、原子）。 */
  private inCode = false
  private inTable = false

  constructor(
    options: SegmentOptions = {},
    sink: SegmentSink | ((text: string, tokens: number, meta: SegmentMeta, isTail?: boolean, rawTokens?: number) => void),
  ) {
    this.min = options.segmentMinTokens ?? 1500
    this.max = options.segmentMaxTokens ?? 3000
    this.canCut = options.canCut
    this.codeMode = options.codeMode ?? 'keep'
    this.tableMode = options.tableMode ?? 'keep'
    this.onMeta = options.onMeta
    this.emit = typeof sink === 'function'
      ? sink
      : (text: string, tokens: number, meta: SegmentMeta, isTail?: boolean, rawTokens?: number) =>
          sink.onSegment(text, tokens, meta, isTail, rawTokens)
  }

  private tokenCount(): number {
    return Math.round(this.cjk + this.other / 4)
  }

  private gate(): boolean {
    return this.canCut === undefined || this.canCut()
  }

  /**
   * 喂入思考增量文本；返回本次原始计数（供检测器共享，避免二次扫描）。
   * 忽略区的文本**不累计**到段缓冲/段 token，但返回值始终是真实计数——
   * 检测器据此计入总 token（长思考阈值/进度含代码量，见 docs/segment-optimization.md）。
   */
  feed(text: string): RawCount {
    if (!text) return { cjk: 0, other: 0 }
    const raw = countRaw(text)
    this.pendingCjk += raw.cjk
    this.pendingOther += raw.other
    this.pending += text
    for (;;) {
      const nl = this.pending.indexOf('\n')
      if (nl !== -1) {
        const line = this.pending.slice(0, nl)
        this.pending = this.pending.slice(nl + 1)
        const lr = countRaw(line)
        this.pendingCjk -= lr.cjk
        this.pendingOther -= lr.other
        this.handleLine(line)
        continue
      }
      // 超长无换行行：估算 token 接近半个 max 时按句末标点拆出前部句子
      // （防 pending 滞留影响段大小判定、支持无换行长文本切段）；
      // 围栏/表格行（行首 ``` 或 |）等待行完成
      const trimmed = this.pending.trimStart()
      if (
        Math.round(this.pendingCjk + this.pendingOther / 4) > pendingSplitTokens(this.max) &&
        !FENCE_RE.test(trimmed) &&
        !trimmed.startsWith('|')
      ) {
        const m = this.pending.match(/^[^。！？!?；;]*[。！？!?；;]/)
        if (m && m[0].length > 0 && m[0].length < this.pending.length) {
          const sentence = m[0]
          this.pending = this.pending.slice(sentence.length)
          const sr = countRaw(sentence)
          this.pendingCjk -= sr.cjk
          this.pendingOther -= sr.other
          this.handleLine(sentence)
          continue
        }
      }
      break
    }
    return raw
  }

  private handleLine(line: string): void {
    // ---- ignore 模式：忽略区结束标记 ----
    if (this.ignore === 'fence') {
      if (FENCE_RE.test(line)) {
        this.ignore = 'none'
        this.pendingIgnoreTokens += this.ignoreTokens
        this.ignoreTokens = 0
        this.onMeta?.({ kind: 'code', lines: this.metaLines, lang: this.metaLang || undefined })
      } else {
        this.metaLines++
        this.ignoreTokens += this.lineTokens(line) // 代码行 token 计入原始 token
      }
      return
    }
    if (this.ignore === 'table') {
      const k = classifyLine(line, false).kind
      if (k === 'table' || k === 'table-sep' || k === 'blank') {
        this.metaLines++
        this.ignoreTokens += this.lineTokens(line) // 表格行 token 计入原始 token
        return
      }
      this.ignore = 'none'
      this.pendingIgnoreTokens += this.ignoreTokens
      this.ignoreTokens = 0
      this.onMeta?.({ kind: 'table', lines: this.metaLines })
      // fallthrough：该行作为正常内容行处理
    }

    // ---- keep 模式：代码/表格块内（内容保留、原子） ----
    if (this.inCode) {
      if (FENCE_RE.test(line)) {
        this.inCode = false
        this.append(line)
        this.cutBuf() // 代码段收尾（含闭合行）
      } else {
        this.append(line) // 代码行直接累积（不检查边界/max，永不因 max 在代码内部切）
      }
      return
    }
    if (this.inTable) {
      const k = classifyLine(line, false).kind
      if (k === 'table' || k === 'table-sep' || k === 'blank') {
        this.append(line)
        return
      }
      this.inTable = false
      if (this.gate() && this.tokenCount() >= this.min) this.cutBuf() // 表格段收尾（切在行前）
      this.append(line)
      return
    }

    // ---- 正常路径 ----
    const kind = classifyLine(line, false)
    if (kind.kind === 'fence-open') {
      if (this.gate() && this.tokenCount() >= this.min && this.buf) this.cutBuf() // 散文段收尾
      if (this.codeMode === 'ignore') {
        this.ignore = 'fence'
        this.metaLines = 0
        this.metaLang = line.replace(/^\s{0,3}(?:```|~~~)\s*/, '').trim()
        return
      }
      this.append(line)
      this.inCode = true
      return
    }
    if (kind.kind === 'table' || kind.kind === 'table-sep') {
      if (this.gate() && this.tokenCount() >= this.min && this.buf) this.cutBuf() // 散文段收尾
      if (this.tableMode === 'ignore') {
        this.ignore = 'table'
        this.metaLines = 1
        return
      }
      this.append(line)
      this.inTable = true
      return
    }
    // 普通内容行：边界切在行前，行内容入段
    if (this.gate() && this.tokenCount() >= this.min && isBoundaryLine(kind.kind, line)) this.cutBuf()
    this.append(line)
    if (this.gate() && this.tokenCount() >= this.max) {
      const pos = this.backtrackSentenceEnd()
      // 切后剩余 < min：并入当前段（整段切出，无小残留）——避免"中间过小段"；
      // 段大小 ≤ max + min，缓冲仍有界
      const rest = this.buf.slice(pos)
      const rr = countRaw(rest)
      if (Math.round(rr.cjk + rr.other / 4) < this.min) this.cutBuf(this.buf.length)
      else this.cutBuf(pos)
    }
  }

  private append(line: string): void {
    this.buf += line + '\n'
    const r = countRaw(line)
    this.cjk += r.cjk
    this.other += r.other
  }

  /** 单行原始 token 估算（CJK≈1/字符，其余≈4/字符，与 estimateTokens 同口径）。 */
  private lineTokens(line: string): number {
    const r = countRaw(line)
    return Math.round(r.cjk + r.other / 4)
  }

  /** 在指定位置切段（默认切到尾）；剩余文本续接为下一段。
   *  isTail：flush 切出的末尾段（可能 < min，仍保留并精炼——末尾结论不丢）。
   *  rawTokens = 段文本 token + 本段之前已结束忽略区（代码/表格）的 token，
   *  即"精炼前/忽略前"的完整原始 token。 */
  private cutBuf(pos = this.buf.length, isTail = false): void {
    const text = this.buf.slice(0, pos).trim()
    const rest = this.buf.slice(pos)
    this.buf = rest
    const r = countRaw(rest)
    this.cjk = r.cjk
    this.other = r.other
    if (!text) return // 空段不吞忽略 token（pendingIgnoreTokens 留给下一段）
    const h = hashText(text)
    if (h === this.lastHash) return
    this.lastHash = h
    const rawTokens = estimateTokens(text) + this.pendingIgnoreTokens
    this.pendingIgnoreTokens = 0
    this.emit(text, estimateTokens(text), analyzeMeta(text), isTail, rawTokens)
  }

  /** max 切点：优先句末回退，其次行末，最后当前位置。 */
  private backtrackSentenceEnd(): number {
    const n = this.buf.length
    const start = Math.max(0, n - MAX_LOOKBACK)
    for (let i = n - 1; i >= start; i--) {
      const ch = this.buf[i]
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';' || ch === '.') {
        return i + 1
      }
    }
    const nl = this.buf.lastIndexOf('\n', n - 1)
    return nl === -1 ? n : nl + 1
  }

  /** 外部强边界（blockType 从 reasoning 切换）：忽略区先收尾元信息，再切段（需达最小窗口）。 */
  signalBoundary(): void {
    if (this.ignore !== 'none') {
      if (this.ignore === 'fence') this.onMeta?.({ kind: 'code', lines: this.metaLines, lang: this.metaLang || undefined })
      else this.onMeta?.({ kind: 'table', lines: this.metaLines })
      this.pendingIgnoreTokens += this.ignoreTokens
      this.ignoreTokens = 0
      this.ignore = 'none'
    }
    if (this.inCode) {
      this.inCode = false
      if (this.buf) this.cutBuf()
      return
    }
    if (this.inTable) {
      this.inTable = false
      if (this.buf) this.cutBuf()
      return
    }
    if (this.gate() && this.tokenCount() >= this.min) this.cutBuf()
  }

  /** 流结束：处理未完成行/忽略区，flush 末尾段（低于下限则丢弃；未达门控不切）。 */
  flush(): void {
    if (this.pending) {
      this.handleLine(this.pending)
      this.pending = ''
      this.pendingCjk = 0
      this.pendingOther = 0
    }
    if (this.ignore !== 'none') {
      if (this.ignore === 'fence') this.onMeta?.({ kind: 'code', lines: this.metaLines, lang: this.metaLang || undefined })
      else this.onMeta?.({ kind: 'table', lines: this.metaLines })
      this.pendingIgnoreTokens += this.ignoreTokens
      this.ignoreTokens = 0
      this.ignore = 'none'
    }
    if (this.inCode) {
      this.inCode = false
      if (this.buf) this.cutBuf()
    }
    if (this.inTable) {
      this.inTable = false
      if (this.buf) this.cutBuf()
    }
    if (this.gate() && this.tokenCount() >= MIN_SEGMENT_FLOOR) this.cutBuf(this.buf.length, true) // 尾巴段：保留且标记（精炼）
  }

  get bufferedTokens(): number {
    return this.tokenCount()
  }
}

/**
 * 静态分段（事后兜底用）：对完整思考文本一次性切段。
 * 与流式共享同一套 Markdown 结构规则（代码块/表格原子，超限不切内部；
 * 内容已完整传入，"忽略"无意义，一律保留并带 meta 标记）。
 */
export function segmentText(text: string, options: SegmentOptions = {}): SegmentPiece[] {
  const min = options.segmentMinTokens ?? 1500
  const max = options.segmentMaxTokens ?? 3000
  const out: SegmentPiece[] = []
  let buf = ''
  let cjk = 0
  let other = 0
  let inCode = false
  let inTable = false
  const tokens = () => Math.round(cjk + other / 4)
  const cut = () => {
    const t = buf.trim()
    buf = ''
    cjk = 0
    other = 0
    if (t) out.push({ text: t, tokens: estimateTokens(t), meta: analyzeMeta(t) })
  }
  for (const rawLine of text.split('\n')) {
    if (inCode) {
      if (FENCE_RE.test(rawLine)) {
        inCode = false
        buf += rawLine + '\n'
        const r = countRaw(rawLine)
        cjk += r.cjk
        other += r.other
        cut() // 代码段收尾（含闭合行）
      } else {
        buf += rawLine + '\n'
        const r = countRaw(rawLine)
        cjk += r.cjk
        other += r.other
      }
      continue
    }
    const kind = classifyLine(rawLine, false)
    if (kind.kind === 'fence-open') {
      if (tokens() >= min && buf) cut() // 散文段收尾
      buf += rawLine + '\n'
      const r = countRaw(rawLine)
      cjk += r.cjk
      other += r.other
      inCode = true
      continue
    }
    if (kind.kind === 'table' || kind.kind === 'table-sep') {
      if (!inTable) {
        if (tokens() >= min && buf) cut() // 散文段收尾
        inTable = true
      }
      buf += rawLine + '\n'
      const r = countRaw(rawLine)
      cjk += r.cjk
      other += r.other
      continue
    }
    if (inTable) {
      // 表格结束：表格段收尾（切在行前）
      if (kind.kind !== 'blank' && tokens() >= min) cut()
      inTable = false
    }
    if (tokens() >= min && isBoundaryLine(kind.kind, rawLine)) cut() // 边界切在行前
    buf += rawLine + '\n'
    const r = countRaw(rawLine)
    cjk += r.cjk
    other += r.other
    if (tokens() >= max) cut()
  }
  cut()
  return out
}
