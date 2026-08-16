/**
 * 共享总结管线：一段思考文本 → 分段 → 逐段总结（启发式/代码块/表格结构化）。
 * 实时路径（stream.ts）用 Segmenter 增量切段；本文件供事后兜底（fallback.ts）
 * 对完整文本一次性处理。保留段原文（text），供精炼任务输入。
 * 另含精炼决策 helper（decideRefine），实时/兜底两条路径共用同一口径。
 */
import type { SegmentOptions } from '../segment.js'
import { segmentText } from '../segment.js'
import { summarizeSegment } from './heuristic.js'

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
 * 事后兜底处理。extra.skipCode/skipTable：代码段/表格段是否跳过精炼
 * （对应设置 codeBlockMode/tableMode 的 keep-skip 分支，默认 ignore 不产出内容段）。
 */
export function processThinking(
  text: string,
  options: SegmentOptions = {},
  extra: { skipCode?: boolean; skipTable?: boolean } = {},
): SegmentOutcome[] {
  const pieces = segmentText(text, options)
  return pieces.map((p, i) => {
    const choice = summarizeSegment(p.text, p.meta, {
      skipCode: extra.skipCode !== false,
      skipTable: extra.skipTable !== false,
    })
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

export interface RefineDecision {
  /** 精炼最小窗口（段 token 低于此值视为"过小"，非末尾段不精炼）。 */
  minRefine: number
  /** 是否过小（tokens < minRefine 且非末尾尾巴段）。 */
  tooSmall: boolean
  /** 过小原因文案（UI 状态标签显示；非过小为 undefined）。 */
  unrefinedReason: string | undefined
}

/**
 * 精炼决策（实时 stream.ts 与兜底 fallback.ts 共用）：
 *  - 非末尾小段（低于段最小窗口）不调小模型精炼：保留启发式摘要，省 token，记原因；
 *  - 末尾尾巴段（isTail，思考结束的结论尾巴）即使 < min 也精炼。
 */
export function decideRefine(
  options: { segmentMinTokens?: number },
  tokens: number,
  isTail?: boolean,
): RefineDecision {
  const minRefine = options.segmentMinTokens ?? 1500
  const tooSmall = tokens < minRefine && !isTail
  return {
    minRefine,
    tooSmall,
    unrefinedReason: tooSmall ? `段过小（${tokens} tok < ${minRefine}）未精炼` : undefined,
  }
}
