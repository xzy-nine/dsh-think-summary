/**
 * M2 分段模块（docs/segment-optimization.md §4）：
 *  - 双阈值：segmentMinTokens 后可切（等语义边界），segmentMaxTokens 强制切
 *  - Markdown 结构感知（mdline.ts）：围栏状态机——围栏内不做边界测试、
 *    代码块整体原子（max 超限在围栏边界/行边界切）；表格整体原子（只在行边界切）；
 *    列表只按项边界切（无序/有序/任务项）
 *  - 边界信号（切在行前，边界行进下一段）：标题、无序/有序/任务列表、引用、
 *    分隔线、行首结构词；围栏闭合为强边界（切在行后，代码段收尾）
 *  - max 强制切回退到最近句末/行末（不在句中/词中切）
 *  - 切段门控 canCut()：阈值前缓冲保留，首个切段包含阈值前文本
 *  - 段内容哈希去重（层内 lastHash + state 级，见 stream.ts）
 *  - 每段附带 SegmentMeta（codeRatio/isTable），供跳过代码段/表格段精炼
 */
import { countRaw, estimateTokens, type RawCount } from './detect.js'
import {
  FENCE_RE,
  classifyLine,
  isBoundaryLine,
  analyzeMeta,
  type SegmentMeta,
} from './mdline.js'

export interface SegmentOptions {
  segmentMinTokens?: number
  segmentMaxTokens?: number
  /**
   * 切段门控：返回 false 时不切（继续缓冲）。用于"阈值后才开始分段"——
   * 阈值前的缓冲会保留，首个切段包含阈值前的思考文本（不再整体丢弃）。
   */
  canCut?: () => boolean
}

export interface SegmentSink {
  onSegment(text: string, tokens: number, meta: SegmentMeta): void
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

/** max 回溯窗口（字符）：在最近窗口内找句末/行末，避免回溯过深。 */
const MAX_LOOKBACK = 6000

/** 边界测试跳过超长未断行（几乎必为代码转储或连续长句，交给 max 句末回溯处理）。 */
const BOUNDARY_TAIL_CAP = 4000

export class Segmenter {
  private buf = ''
  private cjk = 0
  private other = 0
  private readonly min: number
  private readonly max: number
  private readonly canCut: (() => boolean) | undefined
  private readonly emit: (text: string, tokens: number, meta: SegmentMeta) => void
  private lastHash = ''
  /** 上次边界检查位置：只测最近追加的尾部（自上一个 \n 起），避免命中陈旧结构词。 */
  private tailFrom = 0
  /** 围栏状态（基于已完成的整行增量扫描维护）。 */
  private fence = { inFence: false, mark: '', startPos: 0 }
  /** 已完成行的扫描游标（buf 内位置）。 */
  private scanFrom = 0
  /** 当前缓冲段是否**起始**于围栏内（meta 分析种子；max 切分代码块后碎片需要）。 */
  private segFence = false
  /**
   * 最近一次围栏闭合行的结束位置（buf 坐标，切后失效）。
   * 修复：闭合行与后续内容同一增量到达时，tailFrom 已越过闭合行，
   * 尾行测试看不到它——用闭合事件本身作为强边界。
   */
  private fenceCloseAt = -1

  constructor(
    options: SegmentOptions = {},
    sink: SegmentSink | ((text: string, tokens: number, meta: SegmentMeta) => void),
  ) {
    this.min = options.segmentMinTokens ?? 1500
    this.max = options.segmentMaxTokens ?? 3000
    this.canCut = options.canCut
    this.emit = typeof sink === 'function' ? sink : (text, tokens, meta) => sink.onSegment(text, tokens, meta)
  }

  private tokenCount(): number {
    return Math.round(this.cjk + this.other / 4)
  }

  /** 增量扫描新完成的整行，维护围栏状态（O(新追加)，摊还 O(1)）。 */
  private scanFences(): void {
    const buf = this.buf
    let i = this.scanFrom
    while (i < buf.length) {
      const nl = buf.indexOf('\n', i)
      if (nl === -1) break
      const line = buf.slice(i, nl)
      if (this.fence.inFence) {
        if (FENCE_RE.test(line)) {
          this.fence.inFence = false
          this.fence.mark = ''
          this.fence.startPos = 0
          this.fenceCloseAt = nl + 1 // 闭合行结束（含 \n）：代码段收尾点
        }
      } else if (FENCE_RE.test(line)) {
        this.fence.inFence = true
        const m = FENCE_RE.exec(line)
        this.fence.mark = m ? (m[1] ?? '```') : '```'
        this.fence.startPos = i
      }
      i = nl + 1
    }
    this.scanFrom = i
  }

  /** 计算本次切点位置；无可切返回 -1（未达 min / 非边界 / 代码或表格内部）。 */
  private boundaryCutPos(): number {
    // 围栏闭合事件优先（闭合行与后续内容同增量到达时仍能收尾代码段）
    if (this.fenceCloseAt >= 0) {
      const p = this.fenceCloseAt
      this.fenceCloseAt = -1
      return this.tokenCount() >= this.min ? p : -1
    }
    const t = this.tokenCount()
    if (t >= this.max) return this.findCutPoint()
    if (t >= this.min) {
      const tail = this.buf.slice(this.tailFrom)
      if (!tail || tail.length > BOUNDARY_TAIL_CAP) return -1
      if (this.fence.inFence) {
        // 围栏内：只有闭合行是边界（切在行后，代码段收尾）；代码内容不切
        return FENCE_RE.test(tail) ? this.buf.length : -1
      }
      if (FENCE_RE.test(tail)) return -1 // 疑似代码块起始（不切，等 max 在围栏边界处理）
      const line = classifyLine(tail, false)
      if (line.kind === 'table' || line.kind === 'table-sep') return -1 // 表格整体保留
      if (isBoundaryLine(line.kind, tail)) return this.tailFrom // 切在边界行前，边界行进下一段
      return -1
    }
    return -1
  }

  /** max 切点：优先句末回退，其次行末，最后当前位置（对齐 splitLongLine 精神）。 */
  private findCutPoint(): number {
    const n = this.buf.length
    if (this.fence.inFence) {
      // 段含代码：切在围栏边界（代码块整体进下一段）；纯代码段在代码行间切
      if (this.fence.startPos > 0) return this.fence.startPos
      const nl = this.buf.lastIndexOf('\n', n - 1)
      return nl === -1 ? n : nl + 1
    }
    const start = Math.max(0, n - MAX_LOOKBACK)
    for (let i = n - 1; i >= start; i--) {
      const ch = this.buf[i]
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';' || ch === '.') {
        return i + 1
      }
    }
    const nl = this.buf.lastIndexOf('\n', n - 1)
    if (nl >= start) return nl + 1
    return n
  }

  /** 喂入思考增量文本；返回本次原始计数（供检测器共享，避免二次扫描）。 */
  feed(text: string): RawCount {
    if (!text) return { cjk: 0, other: 0 }
    this.buf += text
    const raw = countRaw(text)
    this.cjk += raw.cjk
    this.other += raw.other
    this.scanFences()
    // 先按当前 buf 刷新 tailFrom：tail 只看**当前最后一行**。
    // 修复：若沿用上一轮的 tailFrom，围栏开行跨增量到达时 tail 会从开行起算，
    // 把开行误判成闭合（FENCE_RE 命中）整段切掉。
    this.tailFrom = this.buf.lastIndexOf('\n') + 1
    if (this.canCut === undefined || this.canCut()) {
      const pos = this.boundaryCutPos()
      if (pos >= 0) this.cutAt(pos)
    }
    return raw
  }

  /** 外部强边界（blockType 从 reasoning 切换）：需达最小窗口。 */
  signalBoundary(): void {
    if (this.canCut !== undefined && !this.canCut()) return
    if (this.tokenCount() >= this.min) this.cutAt(this.buf.length)
  }

  /** 流结束：flush 末尾段（低于下限则丢弃；未达门控不切）。 */
  flush(): void {
    if (this.canCut !== undefined && !this.canCut()) return
    if (this.tokenCount() >= MIN_SEGMENT_FLOOR) this.cutAt(this.buf.length)
  }

  /** 在指定位置切段：前段发出，剩余文本与新围栏状态续接。 */
  private cutAt(pos: number): void {
    const text = this.buf.slice(0, pos).trim()
    const rest = this.buf.slice(pos)
    // 围栏连续性：切点落在当前未闭合围栏内部 → 剩余文本仍在围栏内
    // （max 切分超大代码块时，闭合行尚未到达，rest 的围栏状态必须续接而不是重推）
    const wasInFence = this.fence.inFence && pos > this.fence.startPos
    const wasSegFence = this.segFence
    this.buf = rest
    const r = countRaw(rest)
    this.cjk = r.cjk
    this.other = r.other
    this.tailFrom = rest.lastIndexOf('\n') + 1
    this.fence = wasInFence
      ? { inFence: true, mark: this.fence.mark, startPos: 0 }
      : { inFence: false, mark: '', startPos: 0 }
    this.fenceCloseAt = -1
    this.scanFrom = 0
    this.scanFences()
    this.segFence = wasInFence
    if (!text) return
    const h = hashText(text)
    if (h === this.lastHash) return
    this.lastHash = h
    this.emit(text, estimateTokens(text), analyzeMeta(text, wasSegFence))
  }

  get bufferedTokens(): number {
    return this.tokenCount()
  }
}

/**
 * 静态分段（事后兜底用）：对完整思考文本一次性切段。
 * 与实时 Segmenter 共享同一套 Markdown 结构规则。
 * 超长文本行按句末标点拆分子行；围栏内的行不拆（保持代码行完整）。
 */
export function segmentText(text: string, options: SegmentOptions = {}): SegmentPiece[] {
  const min = options.segmentMinTokens ?? 1500
  const max = options.segmentMaxTokens ?? 3000
  const out: SegmentPiece[] = []
  let buf = ''
  let cjk = 0
  let other = 0
  let fence = { inFence: false, mark: '' }
  /** 当前段是否起始于围栏内（meta 种子；max 切分代码块后的碎片需要）。 */
  let segFence = false
  const tokens = () => Math.round(cjk + other / 4)
  const cut = () => {
    const t = buf.trim()
    buf = ''
    cjk = 0
    other = 0
    if (t) out.push({ text: t, tokens: estimateTokens(t), meta: analyzeMeta(t, segFence) })
    segFence = fence.inFence // 新段起始围栏状态（= 当前行处理后的状态）
  }
  for (const rawLine of text.split('\n')) {
    const inFenceBefore = fence.inFence
    const kind = classifyLine(rawLine, fence.inFence)
    if (kind.kind === 'fence-open') {
      const m = FENCE_RE.exec(rawLine)
      fence = { inFence: true, mark: m ? (m[1] ?? '```') : '```' }
    } else if (kind.kind === 'fence-close') {
      fence = { inFence: false, mark: '' }
    }
    // 代码块起始且已超限：prose 段收尾，代码块独立成段（与流式 findCutPoint 一致）
    if (kind.kind === 'fence-open' && tokens() >= max) cut()
    // 边界（达 min 且非代码/表格内部）：切在行前，边界行进下一段
    if (
      !inFenceBefore &&
      kind.kind !== 'table' &&
      kind.kind !== 'table-sep' &&
      tokens() >= min &&
      isBoundaryLine(kind.kind, rawLine)
    ) {
      cut()
    }
    // 围栏内的行不拆（保持代码行完整）；文本超长行按句末标点拆
    const lines = inFenceBefore ? [rawLine] : splitLongLine(rawLine, max)
    for (const line of lines) {
      const t = estimateTokens(line)
      if (tokens() + t >= max && tokens() > 0) cut() // 行边界切（该行起始新段）
      buf += line + '\n'
      const r = countRaw(line)
      cjk += r.cjk
      other += r.other
    }
    // 围栏闭合：代码段收尾（含闭合行；与流式 fenceCloseAt 一致）
    if (kind.kind === 'fence-close' && tokens() >= min) cut()
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
