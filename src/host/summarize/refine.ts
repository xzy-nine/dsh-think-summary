/**
 * M3 小模型精炼（design.md §4.3.2）：
 *  - 门控：仅 refineEnabled 总开关；段 < 段最小窗口不精炼（省 token）
 *  - 模型来源：复用主请求的 provider，`llm.listModels` 选最小可用模型（'auto'）
 *  - 输入硬截断：只喂段尾部 refineMaxInputTokens；输出上限 refineOutputTokens
 *  - 独立队列，并发 1；绝不阻塞主请求（fire-and-forget）
 *  - 异常/中止：错误隔离回退启发式（保留原摘要）；按会话取消未完成任务
 *  - 提示词：默认固定短模板，设置页可修改（refinePrompt）
 */
import { countRaw, estimateTokens } from '../detect.js'
import { DEFAULT_REFINE_PROMPT } from '../config.js'

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
  /** 精炼 system 提示词（设置页可修改；缺省用默认模板）。 */
  refinePrompt?: string
  /** 并行精炼数（并发执行，任务之间互不打断）。 */
  refineConcurrency?: number
  /** 单任务超时（秒）：卡死任务超时放弃并释放并发位，防排队任务永不执行。 */
  refineTimeout?: number
  /**
   * 输入裁剪策略：'headtail' 头尾裁剪（保头+尾、丢中段）；
   * 'tail' 仅保尾部；'full' 完整保留（不裁剪）。头尾裁剪同预算信息量更高，
   * 但中段细节可能丢失——留三档开关供用户权衡。
   */
  trim?: 'headtail' | 'tail' | 'full'
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
  (
    sessionId: string,
    thinkId: string,
    segmentIndex: number,
    refinedSummary: string,
    /** 本次精炼实际消耗（估算）：输入 = 裁剪后喂入的 token，输出 = 摘要 token。 */
    refineTokens: { input: number; output: number },
  ): void
}

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

/**
 * 头尾裁剪（docs/segment-optimization.md §4.C）：保留头部（主题，常在前 20%）
 * 与尾部（结论），丢中段。比"只保尾部"在同等预算下信息量更高。
 */
export function headTailTrim(text: string, budget: number, headRatio = 0.3): string {
  if (estimateTokens(text) <= budget) return text
  const headBudget = Math.max(16, Math.floor(budget * headRatio))
  const tailBudget = budget - headBudget
  const head = takeTokens(text, headBudget, 1)
  const tail = takeTokens(text, tailBudget, -1)
  const mid = '…（中段略）…'
  const out = head + mid + tail
  return estimateTokens(out) <= budget ? out : head + tail
}

/** 从文本一端取约 budget token（按估算密度先取字符再收敛）。 */
function takeTokens(text: string, budget: number, dir: 1 | -1): string {
  const raw = countRaw(text)
  const avg = (raw.cjk + raw.other / 4) / Math.max(1, text.length)
  const targetChars = Math.max(1, Math.floor(budget / Math.max(0.05, avg)))
  let s = dir === 1 ? text.slice(0, targetChars) : text.slice(Math.max(0, text.length - targetChars))
  while (estimateTokens(s) > budget && s.length > 8) {
    s = dir === 1 ? s.slice(0, Math.ceil(s.length * 0.9)) : s.slice(Math.floor(s.length * 0.1))
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

/**
 * 精炼队列（并发池，互不打断）：
 *  - 固定并发上限（refineConcurrency，默认 3）：任务入队即有空位并行执行，
 *    不串行排队、不互相阻塞（一个卡住不再拖住整队）
 *  - **不打断**：任务一旦入队就执行到底（不再按 think 取消/中止）——
 *    新思考/后续任务不会影响已完成思考的在途精炼（修复"部分段不精炼"）
 *  - 错误隔离：单任务失败只记日志，启发式摘要保留，不影响其他任务
 */
export class RefineQueue {
  private queue: RefineTask[] = []
  private running = 0
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

  /** 门控入队（读实时配置）：精炼开关开（段大小/代码跳过由调用方决定）。 */
  enqueue(task: RefineTask): boolean {
    const o = this.getOptions()
    if (o.enabled === false) return false
    this.queue.push(task)
    this.pump()
    return true
  }

  /** 并发水位：有空位就取出任务并行执行；任务结束让出空位并补位。 */
  private pump(): void {
    const cap = Math.max(1, this.getOptions().refineConcurrency ?? 3)
    while (this.running < cap && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) break
      this.running++
      void this.runOne(task).finally(() => {
        this.running = Math.max(0, this.running - 1)
        this.pump()
      })
    }
  }

  get pending(): number {
    return this.queue.length
  }

  private async runOne(task: RefineTask): Promise<void> {
    const o = this.getOptions()
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') {
      // eslint-disable-next-line no-console
      console.error('[dsh-think-summary] refine skipped: llm service unavailable', task.sessionId, task.thinkId, task.segmentIndex)
      return // 启发式保留
    }
    try {
      const model =
        o.model && o.model !== 'auto'
          ? o.model
          : await resolveModel(llm, task.provider, task.fallbackModel)
      // 超时兜底：任务卡死（llm 永不返回）时不占死并发位——超时放弃该任务
      // 并释放空位，后续排队任务继续（否则并发位被卡死任务占满，排队的段永不精炼）
      const timeoutMs = (o.refineTimeout ?? 60) * 1000
      const res = await Promise.race([
        this.runRefine(llm, task, model, o.maxInputTokens ?? 1500, o.outputTokens ?? 1024),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('refine timeout after ' + timeoutMs + 'ms')), timeoutMs)
        }),
      ])
      if (res && res.text.length > 0) {
        this.apply(task.sessionId, task.thinkId, task.segmentIndex, res.text, {
          input: res.inputTokens,
          output: estimateTokens(res.text),
        })
      }
    } catch (error) {
      // 错误隔离：任何异常只丢这次精炼，启发式摘要保留，不影响主请求与其他任务；
      // 记录失败便于排查"未精炼"的段（含超时）
      // eslint-disable-next-line no-console
      console.error(
        '[dsh-think-summary] refine failed:',
        task.sessionId,
        task.thinkId,
        'seg',
        task.segmentIndex,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async runRefine(
    llm: LlmLike,
    task: RefineTask,
    model: string,
    maxInputTokens: number,
    outputTokens: number,
  ): Promise<{ text: string; inputTokens: number }> {
    // 探测确认（probe-notes.md §M3）：content 必须是内容块（字符串会被拒）；
    // system 走顶层字段；该 provider 不支持 reasoningEffort（勿设置）。
    const trimMode = this.getOptions().trim
    const inputText =
      trimMode === 'tail'
        ? trimToTokens(task.text, maxInputTokens)
        : trimMode === 'full'
          ? task.text
          : headTailTrim(task.text, maxInputTokens)
    const stream = llm.stream({
      provider: task.provider,
      model,
      maxTokens: outputTokens,
      system: this.getOptions().refinePrompt ?? DEFAULT_REFINE_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: inputText }],
        },
      ],
    })
    let out = ''
    for await (const chunk of stream) {
      const c = chunk
      if (c && c.type === 'text-delta' && typeof c.text === 'string') out += c.text
    }
    const trimmed = out.trim()
    const text = trimmed.length > DISPLAY_MAX_CHARS ? trimmed.slice(0, DISPLAY_MAX_CHARS) + '…' : trimmed
    return { text, inputTokens: estimateTokens(inputText) }
  }
}
