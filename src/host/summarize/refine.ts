/**
 * M3 小模型精炼（design.md §4.3.2）：
 *  - 门控：仅 refineEnabled 总开关（早期版本的"肥段门槛"按用户要求移除——
 *    开启即全量精炼）
 *  - 模型来源：复用主请求的 provider，`llm.listModels` 选最小可用模型（'auto'）
 *  - 输入硬截断：只喂段尾部 refineMaxInputTokens；输出上限 refineOutputTokens
 *  - 独立队列，并发 1；绝不阻塞主请求（fire-and-forget）
 *  - 异常/中止：错误隔离回退启发式（保留原摘要）；按会话取消未完成任务
 *  - 固定短提示词模板，不随内容增长
 */
import { estimateTokens } from '../detect.js'

export interface RefineOptions {
  enabled?: boolean
  /** 精炼输入预算（token）：只喂段尾部。 */
  maxInputTokens?: number
  /**
   * API 完成预算（token）：必须覆盖推理+答案（探测确认该模型总是先推理；
   * 预算不足会卡在 max-tokens 不出答案）。答案展示时再截断到 ~60 token。
   */
  outputTokens?: number
  /** 'auto' = 会话 provider 的最小可用模型；或显式模型 id。 */
  model?: string
}

export interface RefineTask {
  sessionId: string
  /** 所属 think（每次思考分组）。 */
  thinkId: string
  segmentIndex: number
  /** 段全文（内部裁剪尾部喂入）。 */
  text: string
  /** 主请求的 provider（与主流同 provider）。 */
  provider: string
  /** 主请求的 model（auto 解析失败时的兜底）。 */
  fallbackModel: string
}

export interface RefineApply {
  (sessionId: string, thinkId: string, segmentIndex: number, refinedSummary: string): void
}

/** 固定提示词模板（一次写好，不随内容增长）。 */
const PROMPT_SYSTEM =
  '你是思考链分段摘要器。用不超过60个字总结给定思考片段的核心内容与结论，只输出总结本身，不要任何前缀或解释。'

/** 展示截断：精炼结果最多保留 ~60 token（约 240 字符）。 */
const DISPLAY_MAX_CHARS = 240

/** llm 服务的最小可用面（防御性类型，不依赖完整契约）。 */
export interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string }>
  listModels?(provider: string): Promise<Array<Record<string, unknown>>>
}

/** 裁剪为尾部预算 token（从前往后丢，保留结尾）。 */
export function trimToTokens(text: string, budget: number): string {
  let s = text
  while (estimateTokens(s) > budget && s.length > 64) {
    s = s.slice(Math.ceil(s.length * 0.25))
  }
  return s
}

/** 'auto' 解析：provider 目录里上下文窗口最小的模型；失败回退主模型。 */
export async function resolveModel(
  llm: LlmLike,
  provider: string,
  fallback: string,
): Promise<string> {
  try {
    if (typeof llm.listModels === 'function') {
      const models = await llm.listModels(provider)
      const scored = (Array.isArray(models) ? models : [])
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({
          id: m.id as string,
          score:
            (m.contextWindow as number | undefined) ??
            (m.maxTokens as number | undefined) ??
            (m.context as number | undefined) ??
            Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => a.score - b.score)
      if (scored[0]) return scored[0].id
    }
  } catch {
    /* 目录不可用时回退主模型 */
  }
  return fallback
}

export class RefineQueue {
  private queue: RefineTask[] = []
  private running = false
  private readonly controllers = new Set<{ aborted?: boolean; abort: () => void }>()
  private readonly getOptions: () => RefineOptions
  private readonly getLlm: () => LlmLike | undefined
  private readonly apply: RefineApply

  constructor(
    getOptions: () => RefineOptions,
    getLlm: () => LlmLike | undefined,
    apply: RefineApply,
  ) {
    this.getOptions = getOptions
    this.getLlm = getLlm
    this.apply = apply
  }

  /** 门控入队（读实时配置）：开启即全量精炼，不做段大小门控。 */
  enqueue(task: RefineTask): boolean {
    const o = this.getOptions()
    if (o.enabled === false) return false
    this.queue.push(task)
    void this.pump()
    return true
  }

  /** 取消某会话的未完成任务与在途任务（主流 error/abort 时调用）。 */
  cancelSession(sessionId: string): void {
    this.queue = this.queue.filter((t) => t.sessionId !== sessionId)
    for (const c of this.controllers) c.abort()
  }

  get pending(): number {
    return this.queue.length
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()
        if (!task) break
        await this.runOne(task)
      }
    } finally {
      this.running = false
    }
  }

  private async runOne(task: RefineTask): Promise<void> {
    const o = this.getOptions()
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') return // 启发式保留
    const controller: { aborted?: boolean; abort: () => void; signal?: AbortSignal } =
      typeof AbortController !== 'undefined' ? new AbortController() : { aborted: false, abort() {} }
    this.controllers.add(controller)
    try {
      const model =
        o.model && o.model !== 'auto'
          ? o.model
          : await resolveModel(llm, task.provider, task.fallbackModel)
      const out = await this.runRefine(llm, task, model, o.maxInputTokens ?? 1500, o.outputTokens ?? 1024, controller.signal)
      if (out && out.length > 0) this.apply(task.sessionId, task.thinkId, task.segmentIndex, out)
    } catch (error) {
      // 错误隔离：任何异常只丢这次精炼，启发式摘要保留，不影响主请求；
      // 记录失败便于排查"未精炼"的段
      // eslint-disable-next-line no-console
      console.error(
        '[dsh-think-summary] refine failed:',
        task.sessionId,
        task.thinkId,
        'seg',
        task.segmentIndex,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      this.controllers.delete(controller)
    }
  }

  private async runRefine(
    llm: LlmLike,
    task: RefineTask,
    model: string,
    maxInputTokens: number,
    outputTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    // 探测确认（probe-notes.md §M3）：content 必须是内容块（字符串会被拒）；
    // system 走顶层字段；该 provider 不支持 reasoningEffort（勿设置）。
    const stream = llm.stream({
      provider: task.provider,
      model,
      maxTokens: outputTokens,
      system: PROMPT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: trimToTokens(task.text, maxInputTokens) }] }],
      signal,
    })
    let out = ''
    for await (const chunk of stream) {
      const c = chunk
      if (c && c.type === 'text-delta' && typeof c.text === 'string') out += c.text
    }
    const trimmed = out.trim()
    return trimmed.length > DISPLAY_MAX_CHARS ? trimmed.slice(0, DISPLAY_MAX_CHARS) + '…' : trimmed
  }
}
