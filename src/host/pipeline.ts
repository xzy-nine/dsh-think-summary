/**
 * 共享总结管线：一段思考文本 → 分段 → 逐段总结（启发式/代码块/表格结构化）。
 * 实时路径（stream.ts）用 Segmenter 增量切段；本函数供事后兜底（fallback.ts）
 * 对完整文本一次性处理。保留段原文（text），供精炼任务输入。
 */
import type { SegmentOptions } from './segment.js'
import { segmentText } from './segment.js'
import { summarizeSegment } from './summarize/heuristic.js'

export interface SegmentOutcome {
  index: number
  /** 段原文（精炼输入用）。 */
  text: string
  summary: string
  tokens: number
  refined: boolean
  /** 'code'/'table' = 结构化摘要已足够，跳过精炼（省 token）。 */
  skipReason?: 'code' | 'table'
  ts: number
}

/**
 * 事后兜底处理。extra.skipCode：代码段是否跳过精炼
 * （对应设置 refineSkipCode，默认 true）。
 */
export function processThinking(
  text: string,
  options: SegmentOptions = {},
  extra: { skipCode?: boolean } = {},
): SegmentOutcome[] {
  const pieces = segmentText(text, options)
  return pieces.map((p, i) => {
    const choice = summarizeSegment(p.text, p.meta, extra.skipCode !== false)
    return {
      index: i,
      text: p.text,
      summary: choice.summary,
      tokens: p.tokens,
      refined: false,
      skipReason: choice.skipReason,
      ts: Date.now(),
    }
  })
}
