/**
 * M1 检测模块：thinking chunk 分类 + 轻量 token 计数 + 阈值门控。
 *
 * StreamChunk 形状已由运行时探测确认（probe-notes.md §1）：
 * thinking 增量块 = `{ type: 'reasoning-delta', index, text }`。
 */

/** 判定一个 chunk 是否 thinking，返回其思考文本；非 thinking 返回 null。 */
export type ThinkClassifier = (chunk: unknown) => string | null

/** 默认分类器：探测确认——reasoning-delta 的 text 字段即思考增量。 */
export const DEFAULT_CLASSIFIER: ThinkClassifier = (chunk: unknown): string | null => {
  const c = chunk as { type?: unknown; text?: unknown }
  if (c && c.type === 'reasoning-delta' && typeof c.text === 'string') return c.text
  return null
}

/** 块类型常量（探测确认）：block-start 的 blockType 取值。 */
export const BLOCK_TYPES = {
  reasoning: 'reasoning',
  text: 'text',
  toolCall: 'tool-call',
} as const

/** chunk.type 常量（探测确认）。 */
export const CHUNK_TYPES = {
  blockStart: 'block-start',
  reasoningDelta: 'reasoning-delta',
  textDelta: 'text-delta',
  toolCallDelta: 'tool-call-delta',
  blockEnd: 'block-end',
  usage: 'usage',
  finish: 'finish',
} as const

/** CJK/全角字符集（token 估算用）。 */
export const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/

export interface RawCount {
  cjk: number
  other: number
}

/** 原始字符计数（不取整）：CJK 1 token/字，其他 4 字符/token。 */
export function countRaw(text: string): RawCount {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return { cjk, other }
}

/** 把原始计数折算为 token 数（估算，仅展示用）。 */
export function rawToTokens(raw: RawCount): number {
  return Math.round(raw.cjk + raw.other / 4)
}

/** 轻量 token 估算：整段文本一次折算。 */
export function estimateTokens(text: string): number {
  return rawToTokens(countRaw(text))
}

export interface DetectOptions {
  /** 长思考判定阈值（thinking tokens）。 */
  thinkThresholdTokens?: number
  /** 是否只处理带 sessionId 的请求（过滤子代理/标题生成等旁路流）。 */
  filterNonAgentLoop?: boolean
}

export interface DetectHooks {
  /** 累计 thinking token 数更新（供 UI 进度）。 */
  onProgress?: (tokens: number) => void
  /** 超过阈值，进入分段模式。 */
  onSpliceStart?: () => void
}

/**
 * 检测器：累计**未取整**的原始计数（逐增量取整会低估拉丁字符流），
 * 阈值判定用折算后的 token 数。
 */
export class ThinkingDetector {
  private cjk = 0
  private other = 0
  private spliced = false
  private readonly threshold: number
  private readonly classifier: ThinkClassifier

  constructor(options: DetectOptions = {}, classifier: ThinkClassifier = DEFAULT_CLASSIFIER) {
    this.threshold = options.thinkThresholdTokens ?? 2000
    this.classifier = classifier
  }

  /** 喂入一个 chunk（内部做分类+计数）。 */
  feed(chunk: unknown, hooks: DetectHooks = {}): number {
    const text = this.classifier(chunk)
    return text ? this.feedText(text, hooks) : this.thinkingTokens
  }

  /** 直接喂入已分类的思考文本（内部再扫一次字符）。 */
  feedText(text: string, hooks: DetectHooks = {}): number {
    if (!text) return this.thinkingTokens
    return this.feedRaw(countRaw(text), hooks)
  }

  /** 喂入外部已算好的原始计数（与分段器共享一次扫描，见 stream.ts）。 */
  feedRaw(raw: RawCount, hooks: DetectHooks = {}): number {
    this.cjk += raw.cjk
    this.other += raw.other
    const tokens = this.thinkingTokens
    hooks.onProgress?.(tokens)
    if (!this.spliced && tokens >= this.threshold) {
      this.spliced = true
      hooks.onSpliceStart?.()
    }
    return tokens
  }

  get thinkingTokens(): number {
    return rawToTokens({ cjk: this.cjk, other: this.other })
  }

  get inSplice(): boolean {
    return this.spliced
  }

  /** 暂停边沿调用：清空累计计数与阈值态，恢复后从新流重新累计。 */
  reset(): void {
    this.cjk = 0
    this.other = 0
    this.spliced = false
  }
}
