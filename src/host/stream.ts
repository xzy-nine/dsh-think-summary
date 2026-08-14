import { ThinkingDetector } from './detect.js'
import type { ThinkStateStore } from './state.js'
import { Segmenter, hashText } from './segment.js'
import { summarizeSegment } from './summarize/heuristic.js'
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
        onMeta: (info) => {
          // 忽略模式：代码块/表格内容不写缓冲，围栏闭/表格结束时产出极简元信息段
          const summary =
            info.kind === 'code'
              ? '代码块 · ' + (info.lang ? info.lang + ' · ' : '') + '约 ' + info.lines + ' 行'
              : '表格 · 约 ' + info.lines + ' 行'
          const h = hashText('meta:' + summary)
          if (state.hashes.has(h)) return
          state.hashes.add(h)
          store.pushSegment(state, think.id, {
            index: think.segments.length,
            summary,
            tokens: 0,
            refined: false,
            skipReason: info.kind,
            ts: Date.now(),
          })
        },
      },
      (text: string, tokens: number, meta) => {
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
        store.pushSegment(state, think.id, {
          index: idx,
          summary: choice.summary,
          tokens,
          refined: false,
          skipReason: choice.skipReason,
          ts: Date.now(),
        })
        if (refine && !choice.skipReason) {
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
        // 内部异常绝不冒泡到主请求（design §8.1）；只取消本次思考未完成的精炼
        refine?.cancelThink(key, think.id)
        store.endThink(key, think.id)
        throw err
      }
    })()
  })
}
