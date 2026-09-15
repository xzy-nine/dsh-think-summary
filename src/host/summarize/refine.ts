/**
 * M3 小模型精炼（design.md §4.3.2）：
 *  - 门控：仅 refineEnabled 总开关；段 < 段最小窗口不精炼（省 token）
 *  - provider 来源：`refineProvider`（'auto' = 复用主请求 provider；或显式指定
 *    任一已注册 provider —— 可手动选用其他供应商的模型）
 *  - 模型来源：所选 provider 的 `llm.listModels` 中上下文窗口最小的可用模型
 *    （refineModel='auto'），或显式模型 id
 *  - 输入硬截断：只喂段尾部 refineMaxInputTokens；输出上限 refineOutputTokens
 *  - 独立队列，并发 1；绝不阻塞主请求（fire-and-forget）
 *  - 异常/中止：错误隔离回退启发式（保留原摘要）；按会话取消未完成任务
 *  - 提示词：默认固定短模板，设置页可修改（refinePrompt）
 */
import { countRaw, estimateTokens } from '../detect.js'
import {
  DEFAULT_REFINE_PROMPT,
  DEFAULT_THINK_PROMPT,
  REFINE_USER_TEMPLATE,
  THINK_USER_TEMPLATE,
} from '../config.js'
import { ModelPoolManager, formatModelRef, shouldDisableReasoning, type ModelPool, type ModelRef } from '../pool.js'

/** 精炼 provider/模型解析结果。 */
export interface RefineRoute {
  /** 实际使用的 provider；'' = 无法解析（不发起调用）。 */
  provider: string
  /** 实际使用的 model；'' = 无法解析（不发起调用）。 */
  model: string
}

export interface RefineOptions {
  enabled?: boolean
  /** 精炼输入预算（token）：只喂段尾部。 */
  maxInputTokens?: number
  /**
   * API 完成预算（token）：必须覆盖推理+答案（探测确认该模型总是先推理；
   * 预算不足会卡在 max-tokens 不出答案）。答案展示时再截断到 ~60 token。
   */
  outputTokens?: number
  /** 'auto' = 跟随主请求 provider；或显式 provider id（可跨供应商）。 */
  provider?: string
  /** 'auto' = 所选 provider 的最小可用模型；或显式模型 id。 */
  model?: string
  /** 精炼 system 提示词（设置页可修改；缺省用默认模板）。 */
  refinePrompt?: string
  /** 整体（整次思考）摘要的 system 提示词（第二遍；缺省用默认模板）。 */
  thinkPrompt?: string
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
  /**
   * 精炼请求是否显式关闭思考（`reasoningEffort: 'off'`）。
   *
   * 只有该模型声明了 `off` 档位（供应商 `compat.supportsReasoningEffort: true`
   * + 模型 `reasoningEfforts.off`）才真正生效；未声明时 llm 服务会以
   * `UNSUPPORTED_REASONING_EFFORT` 明确失败——这是刻意的"失败可见"，
   * 避免静默沿用供应商默认（默认思考的供应商会照旧推理并烧掉预算）。
   */
  disableReasoning?: boolean
  /** 每个模型的并发上限（池子模式；免费模型建议 1）。 */
  poolPerModelConcurrency?: number
  /** 单个任务在池子里的最大尝试轮数（每轮可能换一个模型）。 */
  poolMaxAttempts?: number
}

/** 单个任务在池子里的默认最大尝试轮数。 */
export const DEFAULT_POOL_MAX_ATTEMPTS = 3

export interface RefineTask {
  sessionId: string
  /** 所属 think（每次思考分组）。 */
  thinkId: string
  segmentIndex: number
  /** 段全文（内部裁剪尾部喂入）。 */
  text: string
  /** 主请求的 provider（refineProvider='auto' 时用它；也是兜底归属）。 */
  provider: string
  /** 主请求的 model（auto 解析失败时的兜底）。 */
  fallbackModel: string
  /** 已尝试轮数（池子模式换模型重投时累加，决定何时放弃）。 */
  attempts?: number
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

/** 精炼失败回调：把失败/超时原因写回段（UI 显示"未精炼原因"）。 */
export interface RefineFail {
  (sessionId: string, thinkId: string, segmentIndex: number, reason: string): void
}

/** 整体摘要结果回调（第二遍：段摘要 → 整次思考的一句话动向）。 */
export interface RefineApplyThink {
  (
    sessionId: string,
    thinkId: string,
    summary: string,
    tokens: { input: number; output: number },
  ): void
}

/** 整体摘要失败回调（写回 think 上的原因，UI 可显示）。 */
export interface RefineFailThink {
  (sessionId: string, thinkId: string, reason: string): void
}

/** 整体摘要任务（防抖后入队）。 */
interface ThinkTask {
  sessionId: string
  thinkId: string
  provider: string
  fallbackModel: string
  /** 分段摘要拼接后的输入。 */
  text: string
  /** 重投轮数（模型池模式下换模型重试时累加，决定何时放弃）。 */
  attempts?: number
}

/** 整体摘要防抖窗口（毫秒）：长思考的段摘要陆续产出，只保留最后一次。 */
const THINK_DEBOUNCE_MS = 1200

/** 展示截断：精炼结果最多保留 60 字符（提示词要求 ≤30 字，留一点余量）。 */
const DISPLAY_MAX_CHARS = 60

/** 中日韩表意文字：摘要语言校验用（要求中文输出）。 */
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/

/** markdown 外壳：列表符/引用/标题/编号。 */
const MD_PREFIX_RE = /^(?:[#>\-*+•·]\s*)+/
const NUM_PREFIX_RE = /^\d+\s*[.、)]\s*/
/** 前导词（"总结："/"答案："等），模型爱加而这些不属于摘要本身。 */
const LEAD_WORD_RE = /^(?:思考)?(?:动向|总结|摘要|答案|结论|要点|核心)\s*[:：]\s*/
/** 包裹引号/反引号。 */
const WRAP_RE = /^[`"'“”‘’]+|[`"'“”‘’]+$/g
/** 第一句（到句末标点为止；上限防跑飞）。 */
const FIRST_SENTENCE_RE = /^[^。！？!?；;\n]{1,200}[。！？!?]?/

/**
 * 把模型回复归一化成一条可展示的摘要：
 *  - 只取第一行 → 去 markdown 前缀/编号/引号/"总结："类前导词 → 只取第一句
 *  - 压缩空白；超过 DISPLAY_MAX_CHARS 截断加省略号
 * 目的是让"已精炼"标记名副其实：存下来的必须是一条短摘要，而不是小作文。
 * @param raw - 模型返回的原始文本（已 trim）。
 * @returns 归一化后的摘要；无可用内容时返回空串（调用方按失败处理）。
 */
export function normalizeSummary(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  let s = firstLine.replace(MD_PREFIX_RE, '').replace(NUM_PREFIX_RE, '')
  s = s.replace(LEAD_WORD_RE, '')
  s = s.replace(WRAP_RE, '').trim()
  const sentence = s.match(FIRST_SENTENCE_RE)
  if (sentence !== null) s = sentence[0]
  s = s.replace(/\s+/g, ' ').replace(/\s*([，。；：、])/g, '$1').trim()
  s = s.replace(WRAP_RE, '').trim()
  if (s.length > DISPLAY_MAX_CHARS) s = s.slice(0, DISPLAY_MAX_CHARS) + '…'
  return s
}

/** llm 服务的最小可用面（防御性类型，不依赖完整契约）。 */
export interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string }>
  /** 已注册 provider 路由目录（0.1.5 存在；旧宿主缺失时回退单 provider 行为）。 */
  listProviders?(): Array<{ id?: string; name?: string }>
  listModels?(provider: string): Promise<Array<Record<string, unknown>>>
  /** rc.7 精确模型元数据查询：返回含 context.contextWindow 的解析信息。 */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<Record<string, unknown>>
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

/** 从模型目录条目里读上下文窗口（旧 listModels 启发式用的松散字段）。 */
function modelContextWindow(m: Record<string, unknown>): number | undefined {
  const context = m.context as { contextWindow?: number } | undefined
  const direct =
    (m.contextWindow as number | undefined) ??
    (m.maxTokens as number | undefined) ??
    (m.context as number | undefined)
  return context?.contextWindow ?? direct
}

/** 已注册 provider id 列表（llm.listProviders；旧宿主无该方法时为空）。 */
export function listProviderIds(llm: LlmLike): string[] {
  try {
    const raw = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    return (Array.isArray(raw) ? raw : [])
      .map((p) => (p && typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined))
      .filter((x): x is string => x !== undefined)
  } catch {
    return [] // 目录不可用：调用方按"无从校验"处理，仍按任务 provider 走
  }
}

/**
 * 'auto' 解析：provider 目录里上下文窗口最小的模型；失败返回 ''。
 * rc.7 起 listModels 返回目录不再带 contextWindow，改为逐个
 * llm.resolveModelInfo(provider, model) 精确查询（返回 context.contextWindow）
 * 打分；宿主无 resolveModelInfo（旧版）时回退 listModels 字段启发式。
 *
 * 不跨 provider 兜底：调用方在 provider 与任务 provider 相同时才可用 fallbackModel。
 */
export async function resolveModel(llm: LlmLike, provider: string): Promise<string> {
  if (!provider) return ''
  try {
    const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
    const list = Array.isArray(models) ? models : []
    const ids = list.map((m) => (m && typeof m.id === 'string' ? (m.id as string) : undefined)).filter((x): x is string => Boolean(x))
    if (ids.length === 0) return ''

    // rc.7：resolveModelInfo 精确查询 context.contextWindow（N+1，候选少可接受）
    if (typeof llm.resolveModelInfo === 'function') {
      let best: { id: string; score: number } | undefined
      for (const id of ids) {
        try {
          const info = await llm.resolveModelInfo(provider, id)
          const score = modelContextWindow(info as Record<string, unknown>)
          if (score === undefined) continue
          if (best === undefined || score < best.score) best = { id, score }
        } catch {
          /* 单个模型查询失败：跳过，继续下一个 */
        }
      }
      if (best !== undefined) return best.id
      // 全部查询失败：回退目录顺序第一个
      return ids[0] ?? ''
    }

    // 旧版回退：listModels 字段启发式
    const scored = list
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: m.id as string, score: modelContextWindow(m) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.score - b.score)
    if (scored[0]) return scored[0].id
  } catch {
    /* 目录不可用时由调用方决定是否回退 */
  }
  return ''
}

/**
 * 本次请求可用的输出上限（token），`undefined` = **不知道上限**：
 *  - 模型元数据的 `defaultMaxTokens` = **部署显式配置**的每请求输出上限
 *    （供应商块里写了 `maxTokens` 才有），这是唯一可靠来源。
 *  - 未声明时返回 undefined，**绝不用 `context.contextWindow` 顶替**：
 *    那是输入上下文容量，与各家对 `max_tokens` 的合法区间无关。实测
 *    `st/deepseek-v4-flash` 的 contextWindow 是 1048576，而它的 `max_tokens`
 *    上限只有 65536——用 contextWindow 收敛仍会被供应商 400 拒绝。
 *
 * 存在的理由：`llm.stream` 会把 `maxTokens` **原样**发给供应商，而各家对
 * `max_tokens` 有自己的合法区间——插件曾把用户设的超大预算直接透传，
 * 商汤直接 400（`field MaxTokens invalid, should be in [1, 384000]`）。
 * 主链路不会这样：它只在 agent-loop 显式配置时才发 maxTokens。
 * @param llm - llm 服务最小面。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @returns 配置的输出上限；未声明时 undefined（调用方保持原值，不做猜测性收敛）。
 */
export async function resolveOutputCap(
  llm: LlmLike,
  provider: string,
  model: string,
): Promise<number | undefined> {
  if (!provider || !model || typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = (await llm.resolveModelInfo(provider, model)) as { defaultMaxTokens?: unknown }
    const declared = info.defaultMaxTokens
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return Math.floor(declared)
  } catch {
    /* 元数据不可用：按"上限未知"处理 */
  }
  return undefined
}

/**
 * 收敛实际发送的 `maxTokens`：
 *  - **上限已知**（供应商块声明了 `maxTokens`）→ 不超过上限；这是唯一有依据的收敛。
 *  - **上限未知** → 保留用户配置值，只把脏值（0/负/NaN）修正为安全默认。
 *
 * 未知时不猜测：把一个大预算强行压到某个猜出来的数字，可能让本来能用的
 * 路由（如 buddy）因预算被推理耗尽而失败——那与本次要修的 bug 同类。
 * @param requested - 设置的预算（可能超大或非法）。
 * @param cap - 配置的输出上限；undefined = 未知。
 * @returns 实际发送的 maxTokens（始终为合法正整数）。
 */
export function clampOutputTokens(requested: number | undefined, cap: number | undefined): number {
  const wanted = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : 512 // 配置非法：退回默认预算（摘要只需 ~60 token，512 足够）
  if (cap === undefined) return Math.max(1, wanted)
  return Math.max(1, Math.min(wanted, cap))
}

/**
 * 该模型是否**声明**了 `off` 推理档位（可以显式关思考）。
 *
 * 为什么必须先问再发：llm 服务对未声明的档位**直接抛** UNSUPPORTED_REASONING_EFFORT
 * （`resolveCallWithInfo`），所以无条件发送 `reasoningEffort: 'off'` 会打挂
 * 本来能用的路由。只有模型确实提供 `off` 时才发。
 *
 * 另需知道 pi-ai 的语义边界：`off` 在部分供应商上是"省略 reasoning 字段"，
 * 若该供应商自身默认思考，则 `off` 与不传等价、仍会思考（pi-ai 源码
 * `describableReasoningLevel` 注释写明）。插件能做的到此为止，剩下取决于供应商。
 * @param llm - llm 服务最小面。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @returns 是否可安全发送 `off`。
 */
export async function canDisableReasoning(
  llm: LlmLike,
  provider: string,
  model: string,
): Promise<boolean> {
  if (!provider || !model || typeof llm.resolveModelInfo !== 'function') return false
  try {
    const info = (await llm.resolveModelInfo(provider, model)) as {
      reasoning?: { efforts?: Array<{ id?: unknown }> }
    }
    const efforts = info.reasoning?.efforts
    if (!Array.isArray(efforts)) return false
    return efforts.some((e) => e !== undefined && e !== null && e.id === 'off')
  } catch {
    return false // 元数据不可用：不发，避免把能用的请求打成失败
  }
}

/**
 * 解析一次精炼调用的 provider + model（设置页 provider/model 两个下拉的运行时口径）：
 *  - provider：refineProvider 显式指定且仍已注册 → 用它（可跨供应商）；
 *    否则（'auto'、未注册、旧宿主无目录）→ 任务所属主请求 provider；
 *    显式 provider 已消失时回退任务 provider，避免整段精炼失败。
 *  - model：显式 refineModel 直接用；否则按 provider 目录选最小可用模型，
 *    目录不可用且 provider 与任务 provider 一致时回退任务模型。
 */
export async function resolveRefineRoute(
  llm: LlmLike,
  options: { provider?: string; model?: string },
  task: RefineTask,
): Promise<{ route: RefineRoute; error?: string }> {
  const configured = typeof options.provider === 'string' ? options.provider.trim() : ''
  const ids = listProviderIds(llm)
  let provider = task.provider
  let error: string | undefined
  if (configured.length > 0 && configured !== 'auto') {
    if (ids.length === 0 || ids.includes(configured)) {
      provider = configured
    } else {
      error = `精炼 provider「${configured}」未注册，已回退主请求 provider「${task.provider || '未知'}」`
    }
  }

  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (model.length > 0 && model !== 'auto') return { route: { provider, model }, error }

  const picked = await resolveModel(llm, provider)
  if (picked.length > 0) return { route: { provider, model: picked }, error }
  // 目录不可用：仅当 provider 就是任务 provider 时才可用任务模型（跨 provider 不可用）
  const fallback = provider === task.provider ? task.fallbackModel : ''
  if (fallback.length > 0) return { route: { provider, model: fallback }, error }
  return {
    route: { provider: '', model: '' },
    error: error
      ? `${error}；且「${provider || '未知'}」无可用模型`
      : `provider「${provider || '未知'}」无可用模型（模型目录不可用）`,
  }
}

/**
 * 精炼队列（并发池，互不打断）：
 *  - 固定并发上限（refineConcurrency，默认 3）：任务入队即有空位并行执行，
 *    不串行排队、不互相阻塞（一个卡住不再拖住整队）
 *  - **不打断**：任务一旦入队就执行到底（不再按 think 取消/中止）——
 *    新思考/后续任务不会影响已完成思考的在途精炼（修复"部分段不精炼"）
 *  - 错误隔离：单任务失败只记日志，启发式摘要保留，不影响其他任务
 *  - 两遍：段摘要（第一遍）+ 整体摘要（第二遍，把段摘要再喂一次，防抖合并）
 */
export class RefineQueue {
  private queue: RefineTask[] = []
  private thinkQueue: ThinkTask[] = []
  /** 每个 think 一个防抖定时器（键：sessionId\u0000thinkId）。 */
  private thinkPending = new Map<string, ReturnType<typeof setTimeout>>()
  private running = 0
  private readonly getOptions: () => RefineOptions
  private readonly getLlm: () => LlmLike | undefined
  private readonly apply: RefineApply
  private readonly onFail?: RefineFail
  private readonly applyThink?: RefineApplyThink
  private readonly onThinkFail?: RefineFailThink
  /**
   * 模型池管理器（由外部注入，便于**与任务翻译共用同一个池子**：
   * 只有共用，两者才会真正互相轮转、并共享退避状态）。
   */
  private pools: ModelPoolManager | undefined
  /** 正在执行的段精炼任务（用于 hasPendingFor：整体摘要要等它们落定）。 */
  private runningTasks: RefineTask[] = []

  constructor(
    getOptions: () => RefineOptions,
    getLlm: () => LlmLike | undefined,
    apply: RefineApply,
    onFail?: RefineFail,
    applyThink?: RefineApplyThink,
    onThinkFail?: RefineFailThink,
  ) {
    this.getOptions = getOptions
    this.getLlm = getLlm
    this.apply = apply
    this.onFail = onFail
    this.applyThink = applyThink
    this.onThinkFail = onThinkFail
  }

  /**
   * 注入模型池管理器（可选；不注入则走单模型路径）。
   * @param pools - 与任务翻译共用的池子管理器。
   */
  usePool(pools: ModelPoolManager): void {
    this.pools = pools
  }

  /** 门控入队（读实时配置）：精炼开关开（段大小/代码跳过由调用方决定）。 */
  enqueue(task: RefineTask): boolean {
    const o = this.getOptions()
    if (o.enabled === false) return false
    this.queue.push(task)
    this.pump()
    return true
  }

  /**
   * 整体（整次思考）摘要：把该 think 的分段摘要再喂一次模型，得到一句覆盖整体的动向。
   *
   * 防抖：同一次思考的段摘要会随精炼陆续产出，1.2s 内的多次调用只保留最后一次
   * （每次都用最新的完整段摘要列表），避免长思考打出十几次整体摘要请求。
   *
   * @param input - 会话/think 标识、段摘要列表、路由兜底信息。
   * @returns 是否已排入防抖（`false` = 精炼关闭或没有可用摘要）。
   */
  enqueueThink(input: {
    sessionId: string
    thinkId: string
    provider: string
    fallbackModel: string
    segments: readonly string[]
  }): boolean {
    const o = this.getOptions()
    if (o.enabled === false || !this.applyThink || !this.onThinkFail) return false
    const text = input.segments
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('；')
    if (text.length === 0) return false
    const key = `${input.sessionId}\u0000${input.thinkId}`
    const pending = this.thinkPending.get(key)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.thinkPending.delete(key)
      this.thinkQueue.push({ ...input, text })
      this.pump()
    }, THINK_DEBOUNCE_MS)
    this.thinkPending.set(key, timer)
    return true
  }

  get pendingThink(): number {
    return this.thinkQueue.length
  }

  /**
   * 该 think 是否还有在途的段精炼（排队中或正在跑）。
   *
   * 用途：思维链结束时最后几段可能还在精炼，整体摘要要等它们落定再汇总，
   * 否则会漏掉最后一段的精炼结果（只能用启发式摘要顶替）。
   * @param sessionId - 会话 id。
   * @param thinkId - think id。
   * @returns 是否还有未完成的段精炼。
   */
  hasPendingFor(sessionId: string, thinkId: string): boolean {
    return this.queue.some((t) => t.sessionId === sessionId && t.thinkId === thinkId)
      || this.runningTasks.some((t) => t.sessionId === sessionId && t.thinkId === thinkId)
  }

  /**
   * 并发水位：有空位就取出任务并行执行；任务结束让出空位并补位。
   *
   * 池子模式下的容量 = **模型数 × 每模型并发**：并发不再"对着一个模型压"，
   * 而是每个模型各自一份额度（免费模型各有限流，正好各用各的）。
   * 单模型模式仍用 `refineConcurrency`。
   */
  private pump(): void {
    const cap = this.capacity()
    while (this.running < cap && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) break
      this.running++
      this.runningTasks.push(task)
      void this.runOne(task).finally(() => {
        this.running = Math.max(0, this.running - 1)
        const i = this.runningTasks.indexOf(task)
        if (i >= 0) this.runningTasks.splice(i, 1)
        this.pump()
      })
    }
    while (this.running < cap && this.thinkQueue.length > 0) {
      const task = this.thinkQueue.shift()
      if (!task) break
      this.running++
      void this.runThink(task).finally(() => {
        this.running = Math.max(0, this.running - 1)
        this.pump()
      })
    }
  }

  /** 当前总并发上限（池子模式按模型数放大，否则用 refineConcurrency）。 */
  private capacity(): number {
    const o = this.getOptions()
    const pool = this.pools?.current()
    if (pool !== undefined && pool.size > 0) {
      return Math.max(1, pool.size * Math.max(1, Math.floor(o.poolPerModelConcurrency ?? 1)))
    }
    return Math.max(1, o.refineConcurrency ?? 3)
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
      // 同样写回原因：否则 UI 只会显示"待精炼"，看不出是宿主能力缺失
      this.onFail?.(task.sessionId, task.thinkId, task.segmentIndex, 'llm 服务不可用（宿主未挂载）')
      return // 启发式保留
    }
    try {
      // **池子模式**：多模型轮转、每模型并发、失败换模型重投。
      const pool = this.pools?.current()
      if (pool !== undefined && pool.size > 0) {
        await this.runViaPool(llm, task, pool, o)
        return
      }
      // 单模型路径（池子为空 = 未配置多模型）：保持原有行为
      const { route, error } = await resolveRefineRoute(llm, { provider: o.provider, model: o.model }, task)
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[dsh-think-summary] refine route degraded:', error)
      }
      if (!route.provider || !route.model) {
        this.onFail?.(task.sessionId, task.thinkId, task.segmentIndex, error ?? '精炼模型不可用')
        return
      }
      // 超时兜底：任务卡死（llm 永不返回）时不占死并发位——超时放弃该任务
      // 并释放空位，后续排队任务继续（否则并发位被卡死任务占满，排队的段永不精炼）
      const timeoutMs = (o.refineTimeout ?? 60) * 1000
      const res = await Promise.race([
        this.runRefine(llm, task, route, o.maxInputTokens ?? 1500, o.outputTokens ?? 1024),
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
      const reason = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.error(
        '[dsh-think-summary] refine failed:',
        task.sessionId,
        task.thinkId,
        'seg',
        task.segmentIndex,
        reason,
      )
      this.onFail?.(task.sessionId, task.thinkId, task.segmentIndex, reason)
    }
  }

  /**
   * 池子模式下一次精炼：轮转取模型 → 失败则退避并换下一个模型重投。
   *
   * 重投的语义：一个任务最多尝试 `poolMaxAttempts` 轮（默认 3），每轮都重新
   * `pick()`，因此**同一任务可能被不同模型处理**——这正是"一个模型限流了，
   * 别的模型顶上"的实现。全部尝试失败才写回失败原因（并带上最后一轮的错）。
   * @param llm - llm 服务。
   * @param task - 精炼任务。
   * @param pool - 当前模型池。
   * @param o - 实时配置。
   */
  private async runViaPool(
    llm: LlmLike,
    task: RefineTask,
    pool: ModelPool,
    o: RefineOptions,
  ): Promise<void> {
    const outcome = await this.attemptViaPool(llm, pool, o, {
      // 段精炼：输入取段尾（按裁剪策略），并把"重新入队等待退避"接回精炼队列
      run: (ref, attempt, usedOff) => this.runRefine(
        llm, task, { provider: ref.provider, model: ref.model },
        o.maxInputTokens ?? 1500, o.outputTokens ?? 1024, attempt, usedOff,
      ),
      budgetOf: () => task.attempts ?? 0,
      noteRequeue: (next) => { task.attempts = next },
      requeue: () => { this.queue.push(task); this.pump() },
      onFail: (reason) => this.onFail?.(task.sessionId, task.thinkId, task.segmentIndex, reason),
      logLabel: 'refine',
    })
    if (outcome.ok && outcome.text !== undefined) {
      this.apply(task.sessionId, task.thinkId, task.segmentIndex, outcome.text, {
        input: outcome.inputTokens ?? 0,
        output: estimateTokens(outcome.text),
      })
    }
  }

  /**
   * 模型池的**公共取用引擎**（段精炼与整体摘要共用，含任务看板翻译的同款语义）。
   *
   * 提供三件事，两种摘要都靠它（此前整体摘要漏接池子，仍走单模型路径）：
   *  1. **轮转**：每轮 `pick()`，一个任务可能被不同模型处理；
   *  2. **指数退避**：失败模型退避，其他模型顶上；全不可用时把任务放回队列等待；
   *  3. **自动开关思考**：同一模型先不带 `reasoningEffort`，失败后带上再试。
   *
   * @param llm - llm 服务。
   * @param pool - 当前模型池。
   * @param o - 实时配置。
   * @param opts - 任务相关的回调与预算读取。
   * @returns 成功时的文本与输入 token；失败/已重排队时 `ok:false`。
   */
  private async attemptViaPool(
    llm: LlmLike,
    pool: ModelPool,
    o: RefineOptions,
    opts: {
      run: (ref: ModelRef, attempt: number, usedOff: boolean) => Promise<{ text: string; inputTokens: number }>
      budgetOf: () => number
      noteRequeue: (next: number) => void
      requeue: () => void
      onFail: (reason: string) => void
      logLabel: string
    },
  ): Promise<{ ok: boolean; text?: string; inputTokens?: number }> {
    const maxAttempts = Math.max(1, Math.floor(o.poolMaxAttempts ?? DEFAULT_POOL_MAX_ATTEMPTS))
    // 跨"重新入队"的总轮数上限：模型退避时任务会放回队列等待，但**必须有界**——
    // 否则一个恒定失败的任务（如提示词本身有问题）会无限重投。
    const totalBudget = maxAttempts * 3
    const timeoutMs = (o.refineTimeout ?? 60) * 1000
    let lastReason = ''
    let lastRef: ModelRef | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (opts.budgetOf() >= totalBudget) {
        opts.onFail(lastReason || '重试次数已达上限')
        return { ok: false }
      }
      const ref = pool.pick()
      if (ref === undefined) {
        // 全部在退避/满载：把任务放回队列并安排一次唤醒（不在这里空转、不丢任务）
        const wait = Math.max(200, pool.nextWakeMs())
        const next = opts.budgetOf() + 1
        opts.noteRequeue(next)
        if (next > totalBudget) {
          opts.onFail('模型池持续不可用（已放弃）')
          return { ok: false }
        }
        setTimeout(() => opts.requeue(), wait)
        return { ok: false }
      }
      lastRef = ref
      pool.acquire(ref)
      // 自动开关思考（**带记忆**）：已学到的结论直接照用，只有没试出结论时才探测。
      // 关键：不能每次都从"先不带"重来——会思考的模型不带 reasoningEffort 实测要
      // 15~25s，带了只要 ~1s，每次白烧一遍就是"比单模型还慢"的根因。
      const preference = pool.reasoningPreferenceOf(ref)
      const tries = o.disableReasoning === true && preference === 'undecided' ? 2 : 1
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        for (let variant = 0; variant < tries; variant++) {
          const modelAttempt = pool.attemptsOf(ref)
          // 本次是否发送 reasoningEffort（决定权交给池子：已学到的结论优先）
          const usedOff = shouldDisableReasoning(o.disableReasoning === true, modelAttempt, preference)
          try {
            const res = await Promise.race([
              opts.run(ref, modelAttempt, usedOff),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs)
              }),
            ])
            if (res && res.text.length > 0) {
              pool.succeeded(ref, usedOff)
              return { ok: true, text: res.text, inputTokens: res.inputTokens }
            }
          } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error)
            pool.noteAttempt(ref) // 下次这个模型换一种开关再试（仅在未试出结论时）
            if (variant === tries - 1) {
              pool.failed(ref, usedOff, lastReason)
              // eslint-disable-next-line no-console
              console.warn(
                '[dsh-think-summary] ' + opts.logLabel + ' attempt failed, backing off:',
                formatModelRef(ref), lastReason, '（attempt ' + (attempt + 1) + '/' + maxAttempts + '）',
              )
            } else {
              // eslint-disable-next-line no-console
              console.warn('[dsh-think-summary] ' + opts.logLabel + ' 切换思考开关重试:', formatModelRef(ref), lastReason)
            }
          } finally {
            if (timer !== undefined) { clearTimeout(timer); timer = undefined }
          }
        }
      } finally {
        pool.release(ref)
      }
    }

    // 本轮尝试全失败：写回原因，并在退避到期后**有限次**重投
    const where = lastRef === undefined ? '' : formatModelRef(lastRef) + ' '
    const reason = lastReason !== '' ? lastReason : '模型池暂无可用模型'
    opts.onFail(where + reason)
    const next = opts.budgetOf() + 1
    opts.noteRequeue(next)
    const wait = pool.nextWakeMs()
    if (wait > 0 && next <= totalBudget) setTimeout(() => opts.requeue(), wait)
    return { ok: false }
  }

  private async runRefine(
    llm: LlmLike,
    task: RefineTask,
    route: RefineRoute,
    maxInputTokens: number,
    outputTokens: number,
    attempt = 0,
    usedOff = false,
  ): Promise<{ text: string; inputTokens: number }> {
    // 探测确认（probe-notes.md §M3）：content 必须是内容块（字符串会被拒）；system 走顶层字段。
    const trimMode = this.getOptions().trim
    const inputText =
      trimMode === 'tail'
        ? trimToTokens(task.text, maxInputTokens)
        : trimMode === 'full'
          ? task.text
          : headTailTrim(task.text, maxInputTokens)
    const stream = await this.buildRequest(llm, route, outputTokens, this.getOptions().refinePrompt ?? DEFAULT_REFINE_PROMPT,
      REFINE_USER_TEMPLATE.replace('{text}', inputText), attempt, usedOff)
    const text = await readSummaryStream(stream, `${route.provider}/${route.model}`)
    return { text, inputTokens: estimateTokens(inputText) }
  }

  /**
   * 构造一次精炼请求（段精炼与整体摘要共用）：收敛 maxTokens、按需关思考。
   *
   * `maxTokens` 必须先收敛：llm 会把它原样发给供应商，各家各有合法区间
   * （商汤：`field MaxTokens invalid, should be in [1, 384000]`）。
   *
   * **关闭思考由调用方决定**（`wantOff`）：池子会结合"该模型学到的结论"给出，
   * 已学到"带 off 可靠"的模型直接走快路径（实测不带要 15~25s、带了 ~1s），
   * 不再每次任务都从零试错。这里仍叠加 `canDisableReasoning` 兜底：模型没声明
   * off 档位时绝不发送（llm 对未声明档位直接抛错，发了会把本来可用的路由打挂）。
   * @param llm - llm 服务。
   * @param route - 解析后的 provider/model。
   * @param outputTokens - 用户配置的输出预算。
   * @param system - system 提示词。
   * @param userText - user 消息正文。
   * @param attempt - 该模型本轮第几次尝试（从 0 起）。
   * @param wantOff - 本次是否希望关闭思考（由池子按已学到的结论决定）。
   * @returns 模型流。
   */
  private async buildRequest(
    llm: LlmLike,
    route: RefineRoute,
    outputTokens: number,
    system: string,
    userText: string,
    attempt = 0,
    wantOff = false,
  ): Promise<AsyncIterable<{ type?: string; text?: string }>> {
    void attempt
    const [cap, canOff] = await Promise.all([
      resolveOutputCap(llm, route.provider, route.model),
      wantOff ? canDisableReasoning(llm, route.provider, route.model) : Promise.resolve(false),
    ])
    return llm.stream({
      provider: route.provider,
      model: route.model,
      maxTokens: clampOutputTokens(outputTokens, cap),
      // 摘要任务要稳定：不要采样发散（温度 0）
      temperature: 0,
      // 已学到该模型能关思考就带（快路径）；没声明 off 档位的模型绝不含糊发出去
      ...canOff ? { reasoningEffort: 'off' } : {},
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
  }

  /**
   * 第二遍：整体摘要。把该 think 的分段摘要合并成一句覆盖整次思考的动向。
   * 输入是**摘要们**（不是思考原文），所以很小，直接用同样的裁剪兜底。
   */
  private async runThinkRefine(
    llm: LlmLike,
    task: ThinkTask,
    route: RefineRoute,
    maxInputTokens: number,
    outputTokens: number,
    attempt = 0,
    usedOff = false,
  ): Promise<{ text: string; inputTokens: number }> {
    const inputText = headTailTrim(task.text, maxInputTokens)
    const stream = await this.buildRequest(llm, route, outputTokens, this.getOptions().thinkPrompt ?? DEFAULT_THINK_PROMPT,
      THINK_USER_TEMPLATE.replace('{text}', inputText), attempt, usedOff)
    const text = await readSummaryStream(stream, `${route.provider}/${route.model}`)
    return { text, inputTokens: estimateTokens(inputText) }
  }

  /**
   * 整体摘要任务：**与段精炼同一条池子路径**（轮转 / 每模型并发 / 退避 / 自动开关思考），
   * 池子为空时才回退单模型解析。
   *
   * 此前这里直接 `resolveRefineRoute` 走单模型，导致第二遍摘要绕过了池子：
   * 池子里的模型限流时整体摘要会失败，且它也不参与状态色统计。
   */
  private async runThink(task: ThinkTask): Promise<void> {
    const o = this.getOptions()
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') return
    const routeTask: RefineTask = {
      sessionId: task.sessionId,
      thinkId: task.thinkId,
      segmentIndex: -1,
      text: task.text,
      provider: task.provider,
      fallbackModel: task.fallbackModel,
    }
    try {
      // 池子模式：整体摘要也走轮转 + 退避 + 换模型重试
      const pool = this.pools?.current()
      if (pool !== undefined && pool.size > 0) {
        const outcome = await this.attemptViaPool(llm, pool, o, {
          run: (ref, attempt, usedOff) => this.runThinkRefine(
            llm, routeTask, { provider: ref.provider, model: ref.model },
            o.maxInputTokens ?? 800, o.outputTokens ?? 512, attempt, usedOff,
          ),
          budgetOf: () => task.attempts ?? 0,
          noteRequeue: (next) => { task.attempts = next },
          requeue: () => { this.thinkQueue.push(task); this.pump() },
          onFail: (reason) => this.onThinkFail?.(task.sessionId, task.thinkId, reason),
          logLabel: 'think',
        })
        if (outcome.ok && outcome.text !== undefined) {
          this.applyThink?.(task.sessionId, task.thinkId, outcome.text, {
            input: outcome.inputTokens ?? 0,
            output: estimateTokens(outcome.text),
          })
        }
        return
      }

      // 单模型路径（池子未配置）
      const { route, error } = await resolveRefineRoute(llm, { provider: o.provider, model: o.model }, routeTask)
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[dsh-think-summary] think route degraded:', error)
      }
      if (!route.provider || !route.model) {
        this.onThinkFail?.(task.sessionId, task.thinkId, error ?? '整体摘要模型不可用')
        return
      }
      const timeoutMs = (o.refineTimeout ?? 60) * 1000
      const res = await Promise.race([
        this.runThinkRefine(llm, routeTask, route, o.maxInputTokens ?? 800, o.outputTokens ?? 512),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('think summary timeout after ' + timeoutMs + 'ms')), timeoutMs)
        }),
      ])
      if (res && res.text.length > 0) {
        this.applyThink?.(task.sessionId, task.thinkId, res.text, {
          input: res.inputTokens,
          output: estimateTokens(res.text),
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.error('[dsh-think-summary] think summary failed:', task.sessionId, task.thinkId, reason)
      this.onThinkFail?.(task.sessionId, task.thinkId, reason)
    }
  }
}

/**
 * 读一个模型流并做**终态校验**（段精炼 / 整体摘要 / 任务翻译共用）：
 *  - 终态 `finish{kind:'error'|'aborted'}` 必须抛错——provider 失败不抛异常，
 *    只看 text-delta 会把它静默吞掉（段永远停在"待精炼"，实测踩过）
 *  - 无文本（含 max-tokens 把预算烧在推理上）必须抛错并写回原因
 * @param stream - llm.stream 的 chunk 流。
 * @param where - `provider/model`，写进错误信息便于定位。
 * @returns 原始文本（已 trim，保证非空）。
 */
export async function collectStreamText(
  stream: AsyncIterable<{ type?: string; text?: string }>,
  where: string,
): Promise<string> {
  let out = ''
  let finishKind = ''
  let failure: { message?: string; code?: string; status?: number } | undefined
  for await (const chunk of stream) {
    const c = chunk as {
      type?: string
      text?: string
      reason?: { kind?: string; failure?: { message?: string; code?: string; status?: number } }
    }
    if (c && c.type === 'text-delta' && typeof c.text === 'string') out += c.text
    else if (c && c.type === 'finish') {
      finishKind = c.reason?.kind ?? ''
      failure = c.reason?.failure
    }
  }
  if (finishKind === 'error' || finishKind === 'aborted') {
    const parts = [
      failure?.code,
      failure?.status === undefined ? undefined : `HTTP ${failure.status}`,
      failure?.message,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0)
    throw new Error(`${where} ${finishKind}：${parts.length > 0 ? parts.join(' ') : '无详情'}`)
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) {
    throw new Error(
      `${where} 未返回文本（finish=${finishKind || 'none'}）`
      + (finishKind === 'max-tokens' ? '：预算被推理耗尽，请调大「精炼预算」' : ''),
    )
  }
  return trimmed
}

/**
 * 读一个摘要流并做统一校验（在 {@link collectStreamText} 之上加摘要约束）：
 *  - 归一化后为空、或不是中文，同样抛错（不让英文/小作文冒充"已精炼"）
 * @param stream - llm.stream 的 chunk 流。
 * @param where - `provider/model`，写进错误信息便于定位。
 * @returns 归一化后的摘要（保证非空且含中文）。
 */
async function readSummaryStream(
  stream: AsyncIterable<{ type?: string; text?: string }>,
  where: string,
): Promise<string> {
  const trimmed = await collectStreamText(stream, where)
  const text = normalizeSummary(trimmed)
  if (text.length === 0) throw new Error(`${where} 未返回可用摘要（归一化后为空）`)
  if (!CJK_CHAR_RE.test(text)) throw new Error(`${where} 摘要不是中文：「${text}」`)
  return text
}
