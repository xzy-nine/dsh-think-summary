import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
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
        const { state } = store.ensureThink(sid, `t${turn}`)
        // 给最新已结束的实时 think 打 (turn, step) 标记（供聊天流内 turnTail 匹配；
        // 该步的 llm/stream 刚结束，最新 think 即此步思考）
        const latest = state.thinks[state.thinks.length - 1]
        if (latest && latest.id.startsWith('s') && !latest.active && latest.turn === undefined) {
          latest.turn = turn
          latest.step = step
        }
        if (!entry || entry.text.length === 0) return
        const thinkKey = `t${turn}`
        const { think } = store.ensureThink(sid, thinkKey)
        // 实时路径已产出分段则跳过（该 think 已由实时路径置位 inSplice）
        if (state.inSplice && think.segments.length > 0) return
        const outcomes = processThinking(
          entry.text,
          {
            segmentMinTokens: opts.segmentMinTokens,
            segmentMaxTokens: opts.segmentMaxTokens,
          },
          {
            skipCode: opts.codeBlockMode === 'keep-skip',
            skipTable: opts.tableMode === 'keep-skip',
          },
        )
        if (outcomes.length === 0) return
        const model = defaultModel?.() ?? { provider: '', model: '' }
        const base = think.segments.length
        for (const o of outcomes) {
          const idx = base + o.index
          store.pushSegment(state, thinkKey, {
            index: idx,
            summary: o.summary,
            tokens: o.tokens,
            refined: false,
            skipReason: o.skipReason,
            ts: o.ts,
          })
          // 兜底路径分段同样精炼（若默认模型可解析）；代码段/表格段按配置跳过
          if (refine && !o.skipReason) {
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
