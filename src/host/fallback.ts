import type { ThinkStateStore } from './state.js'
import { estimateTokens } from './detect.js'
import { MIN_SEGMENT_FLOOR } from './segment.js'
import { processThinking, decideRefine } from './summarize/pipeline.js'
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

/** assistant/message 的负载里可能带思考文本的字段（v3 会话格式）。 */
interface AssistantMessageData {
  stream?: Array<{ chunk?: { type?: string; text?: string } }>
  message?: { content?: Array<{ type?: string; text?: string }> }
}

/**
 * 从 `assistant/message` 负载里取出这一步的思考原文。
 *
 * 会话格式 v3 起，逐 delta 的 `assistant/chunk` 日志事件已不存在（流式记录改为
 * 随 `assistant/message.data.stream` 一起提交），所以兜底路径不能再依赖 chunk 缓冲：
 *  1. `data.stream` 的 reasoning-delta 记录（精确重建）
 *  2. `data.message.content` 的 reasoning 内容块（同样的文本，已被合并）
 * @param data - `assistant/message` 的 data 负载。
 * @returns 思考原文；没有思考时为空串。
 */
export function reasoningTextOf(data: AssistantMessageData | undefined): string {
  if (!data) return ''
  const fromStream = (data.stream ?? [])
    .map((record) => record?.chunk)
    .filter((chunk): chunk is { type?: string; text?: string } => chunk !== undefined)
    .filter((chunk) => chunk.type === 'reasoning-delta' && typeof chunk.text === 'string')
    .map((chunk) => chunk.text as string)
    .join('')
  if (fromStream.length > 0) return fromStream
  return (data.message?.content ?? [])
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
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
        data?: {
          turn?: number
          step?: number
          chunk?: { type?: string; text?: string }
          /** v3：assistant/message 的消息体（含 reasoning 内容块）。 */
          message?: { id?: unknown; content?: Array<{ type?: string; text?: string }> }
          /** v3：该步的流式记录（含 reasoning-delta）。 */
          stream?: Array<{ chunk?: { type?: string; text?: string } }>
        }
      }
      if (!e || !e.data) return
      const sid =
        session && typeof (session as { id?: unknown }).id === 'string' ? ((session as { id: string }).id) : undefined
      if (!sid) return
      const turn = e.data.turn ?? 0
      const step = e.data.step ?? 0
      // assistant/message 携带该步消息 id：聊天流内按"思考行下方"渲染时靠它匹配
      const messageId =
        e.data.message && typeof e.data.message.id === 'string' ? e.data.message.id : undefined

      /**
       * 给实时路径（s 开头）的最新未打标 think 打 (turn, step, messageId) 标记，
       * 供聊天流内按步匹配。幂等：已打标/无未打标则跳过。
       * 在 assistant/chunk（流进行中）与 assistant/message（流结束）都调用，
       * 双保险——事件流偶发缺失时任一触发即可打标。
       * 打标是元数据，暂停时也执行（暂停只停止新总结产出）。
       */
      const tagRealtimeThink = () => {
        const s = store.get(sid)
        if (!s) return
        for (let i = s.thinks.length - 1; i >= 0; i--) {
          const t = s.thinks[i]
          if (t && t.id.startsWith('s') && t.turn === undefined) {
            t.turn = turn
            t.step = step
            if (messageId !== undefined) t.messageId = messageId
            break
          }
        }
        // 已打过 turn/step 但还缺 messageId（chunk 阶段先打标、message 阶段补）：
        // 只补当步最近的那一条，避免把上一步的 id 贴到这一步
        if (messageId !== undefined) {
          for (let i = s.thinks.length - 1; i >= 0; i--) {
            const t = s.thinks[i]
            if (t && t.id.startsWith('s') && t.turn === turn && t.step === step) {
              t.messageId = messageId
              break
            }
          }
        }
      }

      if (e.type === 'assistant/chunk') {
        // 流进行中：先打标（不依赖 assistant/message 是否到达）
        tagRealtimeThink()
        // 暂停时停止累积：不再有新总结产出
        if (store.paused) return
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
        if (messageId !== undefined) think.messageId = messageId
        // 给最新已结束的实时 think 打 (turn, step) 标记（供聊天流内 turnTail 匹配）。
        // 从后往前找"最后一个 s 开头、未打标"的 think（该步 llm/stream 刚结束；
        // 不检查 active——assistant/message 事件可能先于流收尾的 endThink 到达，
        // 依赖 active 会漏打标或把标打到错误的 step 上）。
        // 打标是元数据，暂停时也执行——否则暂停期间结束的思考失去 turn 标记，
        // 聊天流内总结条（turnTail 按 turn 匹配）将永远显示不出来
        tagRealtimeThink()
        // 暂停：不补跑分段总结（旧总结照常显示），但上面的打标已执行
        if (store.paused) return
        // 思考原文来源（会话格式 v3 起 `assistant/chunk` 已不存在，流式记录改随
        // assistant/message 一起提交）：
        //  1) 旧宿主：chunk 缓冲（若该事件仍存在）
        //  2) v3：`data.stream` 里的 reasoning-delta 记录
        //  3) v3 兜底：`data.message.content` 的 reasoning 内容块（完整文本）
        const messageText = reasoningTextOf(e.data)
        const thinkText = entry && entry.text.length > 0 ? entry.text : messageText
        if (thinkText.length === 0) return
        // 与实时一致：未达长思考阈值（短思考，如工具调用间的几十 token 思考）
        // 不产出段——实时路径由 inSplice 门控不出段，兜底也必须一致，
        // 否则连续短思考会产生一连串几十 token 的小段
        if (estimateTokens(thinkText) < threshold) return
        // 同 (turn, step) 的实时 think 已产出分段则跳过兜底（防同一思考两套总结）
        const realtimeHasSegs = state.thinks.some(
          (t) => t.id.startsWith('s') && t.turn === turn && t.step === step && t.segments && t.segments.length > 0,
        )
        if (realtimeHasSegs || (state.inSplice && think.segments.length > 0)) return
        const outcomes = processThinking(
          thinkText,
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
          // 精炼决策（实时/兜底共用口径）：末尾段即使 < min 也精炼；非末尾小段不精炼记原因
          const dec = decideRefine(opts, o.tokens, o.index === outcomes.length - 1)
          store.pushSegment(state, thinkKey, {
            index: idx,
            summary: o.summary,
            // 段原文：视图页「再试」重跑精炼用
            source: o.text,
            tokens: o.tokens,
            refined: false,
            skipReason: o.skipReason,
            unrefinedReason:
              refine && !o.skipReason && dec.tooSmall ? dec.unrefinedReason : undefined,
            ts: o.ts,
          })
          // 兜底路径分段同样精炼（若默认模型可解析）；代码段/表格段按配置跳过
          if (refine && !o.skipReason && !dec.tooSmall) {
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
        think.tokens += estimateTokens(thinkText)
        state.thinkingTokens = think.tokens
        if (state.thinkingTokens >= threshold) state.inSplice = true
        state.updatedAt = Date.now()
      }
    } catch {
      /* 兜底失败仅影响本段，不影响会话。 */
    }
  })
}
