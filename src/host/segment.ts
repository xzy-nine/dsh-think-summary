/**
 * M2 分段模块（design.md §4.2）：
 *   - 双阈值：segmentMinTokens 后可切（等语义边界信号），segmentMaxTokens 强制切
 *   - 语义边界信号：标题/要点行、行首结构词（接下来/其次/Finally/Step N 等）、
 *     代码围栏闭合（m 标志锚定行尾）
 *   - 外部强边界（blockType 从 reasoning 切换）→ signalBoundary()（需达最小窗口）
 *   - 只缓存未总结余量，切段即清空；流结束 flush 末尾段（低于下限的小尾巴跳过）
 *   - 段内容哈希去重（配合 state 级去重，见 stream.ts）
 */
import { countRaw, estimateTokens, type RawCount } from './detect.js'

export interface SegmentOptions {
  segmentMinTokens?: number
  segmentMaxTokens?: number
}

export interface SegmentSink {
  onSegment(text: string, tokens: number): void
}

export interface SegmentPiece {
  text: string
  tokens: number
}

/** 语义边界信号（强集合，m 标志）：命中即切（需已达最小窗口）。
 *  结构词必须出现在行首（避免 Now/Next/然后 等高频词在句中误触发）；
 *  代码围栏闭合锚定行尾。 */
export const STRONG_BOUNDARY =
  /(?:^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|(?:接下来|其次|然后|之后|最后|总之|综上|Finally|Second(?:ly)?|Third(?:ly)?|Next,?|Now,?|Step\s+\d+))|(```\s*$)/im

/** flush 时小尾巴下限（token）：低于此值不产出段（design §5 硬规则④）。 */
export const MIN_SEGMENT_FLOOR = 64

/** 哈希去重（FNV-1a 简化）。 */
export function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

export class Segmenter {
  private buf = ''
  private cjk = 0
  private other = 0
  private readonly min: number
  private readonly max: number
  private readonly emit: (text: string, tokens: number) => void
  private lastHash = ''
  /** 上次边界检查位置：只测最近追加的尾部（自上一个 \n 起），避免命中陈旧结构词。 */
  private tailFrom = 0

  constructor(options: SegmentOptions = {}, sink: SegmentSink | ((text: string, tokens: number) => void)) {
    this.min = options.segmentMinTokens ?? 1500
    this.max = options.segmentMaxTokens ?? 3000
    this.emit = typeof sink === 'function' ? sink : (text, tokens) => sink.onSegment(text, tokens)
  }

  private tokenCount(): number {
    return Math.round(this.cjk + this.other / 4)
  }

  /** 喂入思考增量文本；返回本次原始计数（供检测器共享，避免二次扫描）。 */
  feed(text: string): RawCount {
    if (!text) return { cjk: 0, other: 0 }
    this.buf += text
    const raw = countRaw(text)
    this.cjk += raw.cjk
    this.other += raw.other
    const t = this.tokenCount()
    if (t >= this.min) {
      const tail = this.buf.slice(this.tailFrom)
      if (t >= this.max || STRONG_BOUNDARY.test(tail)) this.cut()
    }
    this.tailFrom = this.buf.lastIndexOf('\n') + 1
    return raw
  }

  /** 外部强边界（blockType 从 reasoning 切换）：需达最小窗口。 */
  signalBoundary(): void {
    if (this.tokenCount() >= this.min) this.cut()
  }

  /** 流结束：flush 末尾段（低于下限则丢弃）。 */
  flush(): void {
    if (this.tokenCount() >= MIN_SEGMENT_FLOOR) this.cut()
  }

  private cut(): void {
    const text = this.buf.trim()
    this.buf = ''
    this.cjk = 0
    this.other = 0
    this.tailFrom = 0
    if (!text) return
    const h = hashText(text)
    if (h === this.lastHash) return
    this.lastHash = h
    this.emit(text, estimateTokens(text))
  }

  get bufferedTokens(): number {
    return this.tokenCount()
  }
}

/**
 * 静态分段（事后兜底用）：对完整思考文本一次性切段。
 * 与实时 Segmenter 共享同一套边界规则。
 * 超长行（无换行）先按句末标点拆分子行，避免整行被一次切走。
 */
export function segmentText(text: string, options: SegmentOptions = {}): SegmentPiece[] {
  const min = options.segmentMinTokens ?? 1500
  const max = options.segmentMaxTokens ?? 3000
  const out: SegmentPiece[] = []
  let buf = ''
  let cjk = 0
  let other = 0
  const tokens = () => Math.round(cjk + other / 4)
  const cut = () => {
    const t = buf.trim()
    buf = ''
    cjk = 0
    other = 0
    if (t) out.push({ text: t, tokens: estimateTokens(t) })
  }
  for (const rawLine of text.split('\n')) {
    for (const line of splitLongLine(rawLine, max)) {
      buf += line + '\n'
      const raw = countRaw(line)
      cjk += raw.cjk
      other += raw.other
      if (tokens() >= max) {
        cut()
        continue
      }
      // 只测当前行（行首锚定），避免命中缓冲中陈旧的边界信号
      if (tokens() >= min && STRONG_BOUNDARY.test(line)) cut()
    }
  }
  cut()
  return out
}

/** 把超过 maxTokens 的单行按句末标点拆成 ≤ 目标（0.9×max）的子行；极端句子再按 token 比例硬切。 */
function splitLongLine(line: string, maxTokens: number): string[] {
  if (estimateTokens(line) <= maxTokens) return [line]
  const target = Math.floor(maxTokens * 0.9)
  const parts = line.split(/([。！？!?；;])/)
  const chunks: string[] = []
  let cur = ''
  let curT = 0
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = (parts[i] ?? '') + (parts[i + 1] ?? '')
    const t = estimateTokens(sentence)
    if (curT + t > target && cur) {
      chunks.push(cur)
      cur = sentence
      curT = t
    } else {
      cur += sentence
      curT += t
    }
  }
  if (cur) chunks.push(cur)
  const out: string[] = []
  for (const c of chunks) {
    const tc = estimateTokens(c)
    if (tc > maxTokens) {
      const ratio = Math.max(1, Math.round(tc / maxTokens))
      const step = Math.ceil(c.length / ratio)
      for (let i = 0; i < c.length; i += step) out.push(c.slice(i, i + step))
    } else {
      out.push(c)
    }
  }
  return out
}
