import { ThinkingDetector } from './detect.js'
import type { ThinkStateStore } from './state.js'
import { Segmenter, hashText } from './segment.js'
import { heuristicSummary } from './summarize/heuristic.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/**
 * M1+M2+M3 流包裹：监听 llm/stream 瀑布。
 *  - 只观察 thinking 增量（reasoning-delta），绝不改写/缓冲/阻塞 chunk 流
 *  - 每次 llm/stream 调用 = 一个 think（每次思考分组）
 *  - 检测器累计 token（原始计数），触发长思考阈值
 *  - 分段器按双阈值+语义边界/块切换信号切段；切段门控 = inSplice
 *    （阈值前的缓冲保留，首个切段包含阈值前文本，不再整体丢弃）
 *  - state 级哈希去重；finish/异常均 flush 并 end
 *  - M3：所有分段入精炼队列（fire-and-forget）；主流 error/abort 时按会话取消
 *  - 配置经 getOptions 每次流开始时读取（设置页改动即时生效）
 */
export function installDetect(
  ctx: CtxLike,
  store: ThinkStateStore,
  getOptions: () => ThinkSummaryConfig,
  refine?: RefineQueue | null,
) {
  const agents = ctx.get('agents') as
    | { currentInitiator?: () => { session?: { id?: string }; id?: string } | undefined }
    | undefined

  const resolveSession = (fallback: string | undefined): string | undefined => {
    if (fallback && fallback.length > 0) return fallback
    try {
      const a = agents?.currentInitiator?.()
      const id = a?.session?.id ?? a?.id
      return id === undefined ? undefined : String(id)
    } catch {
      return undefined
    }
  }

  ctx.on('llm/stream', (reqOptions, next) => {
    const opts = getOptions()
    if (opts.enabled === false) return next()
    const ro = reqOptions as { sessionId?: string; provider?: string; model?: string }
    if (opts.filterNonAgentLoop && !ro.sessionId) return next()

    const key = resolveSession(ro.sessionId) ?? 'unknown'
    const { state, think } = store.beginThink(key)
    const detector = new ThinkingDetector({ thinkThresholdTokens: opts.thinkThresholdTokens })
    const segmenter = new Segmenter(
      {
        segmentMinTokens: opts.segmentMinTokens,
        segmentMaxTokens: opts.segmentMaxTokens,
        canCut: () => detector.inSplice,
      },
      (text: string, tokens: number) => {
        // 门控保证 cut 只发生在 inSplice 之后；state 级去重防重试/重放
        const h = hashText(text)
        if (state.hashes.has(h)) return
        state.hashes.add(h)
        const idx = think.segments.length
        store.pushSegment(state, think.id, {
          index: idx,
          summary: heuristicSummary(text),
          tokens,
          refined: false,
          ts: Date.now(),
        })
        if (refine) {
          refine.enqueue({
            sessionId: key,
            thinkId: think.id,
            segmentIndex: idx,
            text,
            provider: ro.provider ?? 'unknown',
            fallbackModel: ro.model ?? '',
          })
        }
      },
    )
    let blockType: string | null = null

    const inner = next()
    return (async function* () {
      try {
        try {
          for await (const chunk of inner) {
            const c = chunk as { type?: string; blockType?: string; text?: string }
            const t = c && c.type
            if (t === 'block-start') {
              // reasoning → 其他块类型：思考段结束的强信号
              if (blockType === 'reasoning' && c.blockType !== 'reasoning') segmenter.signalBoundary()
              blockType = c.blockType ?? null
            } else if (t === 'reasoning-delta' && typeof c.text === 'string' && c.text.length > 0) {
              const raw = segmenter.feed(c.text) // 一次扫描，与检测器共享
              detector.feedRaw(raw, {
                onSpliceStart: () => {
                  state.inSplice = true
                  state.updatedAt = Date.now()
                },
              })
              think.tokens = detector.thinkingTokens
              state.thinkingTokens = think.tokens
              state.updatedAt = Date.now()
            } else if (t === 'finish') {
              segmenter.flush()
              store.endThink(key, think.id)
            }
            yield chunk
          }
        } finally {
          // abort/提前结束/无 finish 的 provider：flush 尾巴并收尾（幂等）
          segmenter.flush()
          store.endThink(key, think.id)
        }
      } catch (err) {
        // 内部异常绝不冒泡到主请求（design §8.1）；取消该会话未完成精炼
        refine?.cancelSession(key)
        store.endThink(key, think.id)
        throw err
      }
    })()
  })
}
