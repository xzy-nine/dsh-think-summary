/**
 * 共享总结管线：一段思考文本 → 分段 → 逐段启发式总结。
 * 实时路径（stream.ts）用 Segmenter 增量切段；本函数供事后兜底（fallback.ts）
 * 对完整文本一次性处理。M3 精炼在此挂载（refine 字段）。
 */
import type { SegmentOptions } from './segment.js'
import { segmentText } from './segment.js'
import { heuristicSummary } from './summarize/heuristic.js'

export interface SegmentOutcome {
  index: number
  summary: string
  tokens: number
  refined: boolean
  ts: number
}

export function processThinking(text: string, options: SegmentOptions = {}): SegmentOutcome[] {
  const pieces = segmentText(text, options)
  return pieces.map((p, i) => ({
    index: i,
    summary: heuristicSummary(p.text),
    tokens: p.tokens,
    refined: false,
    ts: Date.now(),
  }))
}
