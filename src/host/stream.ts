import { ThinkingDetector } from './detect.js'
import type { ThinkStateStore } from './state.js'
import { Segmenter, hashText } from './segment.js'
import { summarizeSegment } from './summarize/heuristic.js'
import { makeSelfSummaryCapture } from './self-summary.js'
import type { RefineQueue } from './summarize/refine.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'

/**
 * M1+M2+M3 流包裹：监听 llm/stream 瀑布。
 *  - 只观察 thinking 增量（reasoning-delta），绝不改写/缓冲/阻塞 chunk 流
 *  - 每次 llm/stream 调用 = 一个 think（每次思考分组）
 *  - 检测器累计 token（原始计数），触发长思考阈值
 *  - 分段器按双阈值 + Markdown 结构边界/块切换信号切段（mdline.ts：
 *    围栏内不切、代码块/表格原子、max 句末回溯）；切段门控 = inSplice
 *  - state 级哈希去重；finish/异常均 flush 并 end
 *  - M3：可精炼分段入精炼队列（fire-and-forget）；代码段/表格段按配置跳过
 *    （refineSkipCode，结构化摘要 0 token 兜底）；主流 error/abort 时按 think 取消
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
        codeMode: opts.codeBlockMode === 'ignore' ? 'ignore' : 'keep',
        tableMode: opts.tableMode === 'ignore' ? 'ignore' : 'keep',
        // 不传 onMeta：ignore 模式下代码块/表格内容丢弃即可，总结卡片不显示任何
        // 代码块/表格痕迹（用户需求：改为不显示；keep 模式走下方 sink 产出内容段）
      },
      (text: string, tokens: number, meta, isTail?: boolean) => {
        // 门控保证 cut 只发生在 inSplice 之后；state 级去重防重试/重放
        const h = hashText(text)
        if (state.hashes.has(h)) return
        state.hashes.add(h)
        const idx = think.segments.length
        // 代码段/表格段（keep 模式）：结构化摘要（0 token），精炼与否按 mode
        const choice = summarizeSegment(text, meta, {
          skipCode: opts.codeBlockMode === 'keep-skip',
          skipTable: opts.tableMode === 'keep-skip',
        })
        // 非末尾小段（低于段最小窗口）不调小模型精炼：保留启发式摘要，省 token，记原因；
        // 末尾尾巴段（isTail，思考结束的结论尾巴）即使 < min 也精炼
        const minRefine = opts.segmentMinTokens ?? 1500
        const tooSmall = tokens < minRefine && !isTail
        store.pushSegment(state, think.id, {
          index: idx,
          summary: choice.summary,
          tokens,
          refined: false,
          skipReason: choice.skipReason,
          unrefinedReason:
            refine && !choice.skipReason && tooSmall
              ? `段过小（${tokens} tok < ${minRefine}）未精炼`
              : undefined,
          ts: Date.now(),
        })
        if (refine && !choice.skipReason && !tooSmall) {
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
    // 主模型自产小结捕获器（selfSummary='prompt' 时启用）：捕获【思考小结】标记，
    // 直接 push 为段摘要（仅展示补充，不影响外部分段/精炼）
    const self = opts.selfSummary === 'prompt' ? makeSelfSummaryCapture((summary) => {
      const h = hashText('self:' + summary)
      if (state.hashes.has(h)) return
      state.hashes.add(h)
      store.pushSegment(state, think.id, {
        index: think.segments.length,
        summary,
        tokens: 0,
        refined: false,
        kind: 'self',
        ts: Date.now(),
      })
    }) : null

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
              self?.feed(c.text) // 主模型自产小结捕获（selfSummary 模式）
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
              self?.flush()
              segmenter.flush()
              store.endThink(key, think.id)
            }
            yield chunk
          }
        } finally {
          // abort/提前结束/无 finish 的 provider：flush 尾巴并收尾（幂等）
          self?.flush()
          segmenter.flush()
          store.endThink(key, think.id)
        }
      } catch (err) {
        // 内部异常绝不冒泡到主请求（design §8.1）；
        // 精炼互不打断：已入队的精炼继续执行到底，不随主流异常取消
        store.endThink(key, think.id)
        throw err
      }
    })()
  })
}
