import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
import { processThinking } from './pipeline.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/**
 * M2 事后兜底路径（design.md §4.3.3）：
 *  - assistant/chunk 事件按 sessionId+turn+step 累积 reasoning-delta 文本
 *    （与实时流同构），缓冲设上限
 *  - assistant/message（每步终态）时，若实时路径未产出（断流/异常/错过），
 *    对该步文本补跑分段+启发式总结，**追加**进会话状态；thinkingTokens 累计，
 *    达到阈值才置 inSplice
 *  - 缓冲按年龄清理；全程 try/catch，绝不冒泡；配置经 getOptions 读取
 */
interface BufEntry {
  text: string
  ts: number
}

const BUF_CAP_CHARS = 200_000
const BUF_TTL_MS = 10 * 60 * 1000

export function installFallback(
  ctx: CtxLike,
  store: ThinkStateStore,
  getOptions: () => ThinkSummaryConfig,
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
        if (!entry || entry.text.length === 0) return
        const s = store.ensure(sid)
        // 实时路径已产出分段则跳过（inSplice 已由实时路径置位）
        if (s.inSplice && s.segments.length > 0) return
        const outcomes = processThinking(entry.text)
        if (outcomes.length === 0) return
        const base = s.segments.length
        for (const o of outcomes) s.segments.push({ ...o, index: base + o.index })
        s.thinkingTokens += estimateTokens(entry.text)
        if (s.thinkingTokens >= threshold) s.inSplice = true
        s.updatedAt = Date.now()
      }
    } catch {
      /* 兜底失败仅影响本段，不影响会话。 */
    }
  })
}
