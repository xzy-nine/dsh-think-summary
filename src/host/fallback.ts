import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
import { MIN_SEGMENT_FLOOR } from './segment.js'
import { processThinking } from './pipeline.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/**
 * M2 事后兜底路径（design.md §4.3.3，v2）：
 *  - assistant/chunk 事件按 sessionId+turn+step 累积 reasoning-delta 文本
 *  - assistant/message（每步终态）时，若实时路径未产出（断流/异常/错过），
 *    对该步文本补跑分段+启发式总结，**追加**进"该 turn 的 think"；
 *    **兜底路径的分段同样入队精炼**（补齐精炼全链路）
 *  - 精炼模型来源：会话默认模型（agentDefaultModel.currentSelection()），
 *    实时请求的 provider 在兜底事件里不可得
 *  - 缓冲按年龄清理；全程 try/catch，绝不冒泡；配置经 getOptions 读取
 */
interface BufEntry {
  text: string
  ts: number
}

const BUF_CAP_CHARS = 200_000
const BUF_TTL_MS = 10 * 60 * 1000

export interface DefaultModel {
  provider: string
  model: string
}

export function installFallback(
  ctx: CtxLike,
  store: ThinkStateStore,
  getOptions: () => ThinkSummaryConfig,
  refine?: RefineQueue | null,
  defaultModel?: () => DefaultModel,
) {
  const buf = new Map<string, BufEntry>()

  const sweepBuf = () => {
    const now = Date.now()
    for (const [k, e] of buf) if (now - e.ts > BUF_TTL_MS) buf.delete(k)
  }

  // 定时清理（timer 服务；无 timer 时兜底路径仍工作，只是不清理）
  const timer = ctx.get('timer') as { interval?: (fn: () => void, ms: number) => unknown } | undefined
  timer?.interval?.(() => {
    store.sweep()
    sweepBuf()
  }, 60_000)

  ctx.on('session/event', (session, event) => {
    try {
      const opts = getOptions()
      if (opts.enabled === false) return
      const threshold = opts.thinkThresholdTokens ?? 2000
      const e = event as {
        type?: string
        data?: { turn?: number; step?: number; chunk?: { type?: string; text?: string } }
      }
      if (!e || !e.data) return
      const sid =
        session && typeof (session as { id?: unknown }).id === 'string' ? ((session as { id: string }).id) : undefined
      if (!sid) return
      const turn = e.data.turn ?? 0
      const step = e.data.step ?? 0

      if (e.type === 'assistant/chunk') {
        const chunk = e.data.chunk
        if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          const k = `${sid}:${turn}:${step}`
          const prev = buf.get(k)
          if (prev && prev.text.length > BUF_CAP_CHARS) return
          buf.set(k, { text: (prev?.text ?? '') + chunk.text, ts: Date.now() })
        }
        return
      }
      if (e.type === 'assistant/message') {
        const k = `${sid}:${turn}:${step}`
        const entry = buf.get(k)
        buf.delete(k)
        // 兜底 think 按 (turn, step) 隔离：同一 turn 的多个 step（如思考→工具调用→再思考）
        // 各自独立成 think，不再合并（修复"已结束的 think 被认为是同一个"）
        const thinkKey = `t${turn}_${step}`
        const { state, think } = store.ensureThink(sid, thinkKey)
        think.turn = turn
        think.step = step
        // 给最新已结束的实时 think 打 (turn, step) 标记（供聊天流内 turnTail 匹配）。
        // 从后往前找"最后一个 s 开头、非活跃、未打标"的 think（该步 llm/stream 刚结束）。
        for (let i = state.thinks.length - 1; i >= 0; i--) {
          const t = state.thinks[i]
          if (t && t.id.startsWith('s') && !t.active && t.turn === undefined) {
            t.turn = turn
            t.step = step
            break
          }
        }
        if (!entry || entry.text.length === 0) return
        // 与实时一致：未达长思考阈值（短思考，如工具调用间的几十 token 思考）
        // 不产出段——实时路径由 inSplice 门控不出段，兜底也必须一致，
        // 否则连续短思考会产生一连串几十 token 的小段
        if (estimateTokens(entry.text) < threshold) return
        // 该 step 实时路径已产出分段则跳过
        if (state.inSplice && think.segments.length > 0) return
        const outcomes = processThinking(
          entry.text,
          {
            segmentMinTokens: opts.segmentMinTokens,
            segmentMaxTokens: opts.segmentMaxTokens,
          },
          {
            // ignore / keep-skip 都不精炼代码/表格段（keep-refine 才精炼）；
            // 兜底路径处理完整文本，无法"不写内存"，但保持与流式一致的精炼决策
            skipCode: opts.codeBlockMode !== 'keep-refine',
            skipTable: opts.tableMode !== 'keep-refine',
          },
        )
        if (outcomes.length === 0) return
        const model = defaultModel?.() ?? { provider: '', model: '' }
        const base = think.segments.length
        for (const o of outcomes) {
          // ignore 模式：代码块/表格段不显示（与流式一致——总结卡片无痕迹）
          if (o.skipReason === 'code' && opts.codeBlockMode === 'ignore') continue
          if (o.skipReason === 'table' && opts.tableMode === 'ignore') continue
          // 微尾段（低于 flush 下限）不产出
          if (o.tokens < MIN_SEGMENT_FLOOR) continue
          const idx = base + o.index
          store.pushSegment(state, thinkKey, {
            index: idx,
            summary: o.summary,
            tokens: o.tokens,
            refined: false,
            skipReason: o.skipReason,
            ts: o.ts,
          })
          // 兜底路径分段同样精炼（若默认模型可解析）；代码段/表格段按配置跳过；
          // 小段（低于段最小窗口）不精炼，省 token
          if (refine && !o.skipReason && o.tokens >= (opts.segmentMinTokens ?? 1500)) {
            refine.enqueue({
              sessionId: sid,
              thinkId: thinkKey,
              segmentIndex: idx,
              text: o.text,
              provider: model.provider || 'unknown',
              fallbackModel: model.model || '',
            })
          }
        }
        think.tokens += estimateTokens(entry.text)
        state.thinkingTokens = think.tokens
        if (state.thinkingTokens >= threshold) state.inSplice = true
        state.updatedAt = Date.now()
      }
    } catch {
      /* 兜底失败仅影响本段，不影响会话。 */
    }
  })
}
