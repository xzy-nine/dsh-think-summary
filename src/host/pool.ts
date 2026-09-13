/**
 * 精炼/翻译的**模型池**：多模型轮转 + 每模型并发 + 指数退避。
 *
 * 起因（用户诉求）：单一 `refineProvider/refineModel` 在免费模型上会被限流
 * （商汤免费额度按分钟限流，实测并发 >1 就 `RATE_LIMIT 429 rpm exhausted`）。
 * 把模型换成"池子"后：
 *  - **轮转**：摘要与翻译都从这个池子里依次取模型，不盯着一个薅；
 *  - **每模型并发**：并发上限是"每个模型几个"，多模型时总并发随模型数放大，
 *    单模型被限流不再拖垮整体；
 *  - **指数退避**：某模型失败后进入退避窗口，期间不再取它，其他模型顶上；
 *  - **可重试**：任务失败后换一个模型重投（最多 maxAttempts 轮），
 *    不再"一次失败就永久停在未精炼"。
 *
 * 与 dsh 的边界：这里只做**调度**，不碰 `llm` 服务契约——真正发请求仍走
 * `llm.stream`，模型能力探测仍走 `llm.resolveModelInfo`（见 refine.ts）。
 */

/** 池子里的一个模型引用。 */
export interface ModelRef {
  /** 供应商 id（如 `st`）。 */
  provider: string
  /** 模型 id（如 `sensenova-6.8-flash-lite`）。 */
  model: string
}

/** 池子条目的运行时状态。 */
interface PoolEntry {
  ref: ModelRef
  /** 当前在飞请求数。 */
  inFlight: number
  /** 退避到该时刻（毫秒时间戳）之前不再取用。 */
  blockedUntil: number
  /** 连续失败次数（指数退避的指数）。 */
  failures: number
  /** 累计成功/失败（诊断用）。 */
  succeeded: number
  failed: number
  /** 该模型在本轮任务里已尝试次数（自动开关思考的重试计数）。 */
  attempts: number
}
/** 池子选项。 */
export interface ModelPoolOptions {
  /** **每个模型**的并发上限（免费模型建议 1）。 */
  perModelConcurrency: number
  /** 退避基数（毫秒）：第 n 次连续失败后等待 base * 2^(n-1)。 */
  backoffBaseMs: number
  /** 退避上限（毫秒）。 */
  backoffMaxMs: number
  /** 取当前时间（测试可注入）。 */
  now?: () => number
  /** 跨进程累计统计（气泡状态色用；不传则只做内存计数）。 */
  stats?: PoolStatsLike
}

/** 统计口的窄接口（避免 pool.ts 依赖 pool-stats 的具体实现）。 */
export interface PoolStatsLike {
  /** 记一次成功。 */
  recordOk(key: string): void
  /** 记一次失败。 */
  recordFail(key: string): void
}

/** 池子的只读快照（诊断/测试用）。 */
export interface PoolSnapshot {
  /** 模型数。 */
  size: number
  /** 每个模型的状态。 */
  entries: Array<{
    provider: string
    model: string
    inFlight: number
    blockedMs: number
    failures: number
    succeeded: number
    failed: number
  }>
}

/** 池子默认值：免费模型友好（每模型 1 并发、退避 2s 起步、上限 60s）。 */
export const POOL_DEFAULTS = {
  perModelConcurrency: 1,
  backoffBaseMs: 2000,
  backoffMaxMs: 60_000,
} as const

/**
 * 该模型这次是否要**关掉思考**（`reasoningEffort: 'off'`）。
 *
 * 自动开关重试的核心：用户开着「关闭思考」但某个模型不认这个字段时，
 * 第一次尝试不带它、失败后再带它试一次（或反过来），即可自动适配两种供应商，
 * 不需要用户为每个模型手配。规则：
 *  - 配置关闭 → 永不发送；
 *  - 第 1 次尝试（attempt 0）→ 不带（保守：先按供应商默认跑）；
 *  - 之后 → 带（上次失败可能正是因为"没关思考导致预算被推理耗尽"）。
 * @param disableReasoning - 配置是否要求关思考。
 * @param attempt - 本次是该模型的第几次尝试（从 0 起）。
 * @returns 是否发送 `reasoningEffort`。
 */
export function shouldDisableReasoning(disableReasoning: boolean, attempt: number): boolean {
  if (!disableReasoning) return false
  return attempt > 0
}

/**
 * 解析池子配置项：接受 `provider/model` 字符串数组（也容忍 `{provider,model}` 对象）。
 *
 * 形状取舍：设置页存的是**字符串数组**（`provider/model`），因为设置桥的
 * 逐字段 set 直接存 JSON 值最省事；`auto` 语义不放进池子（池子就是显式清单），
 * 想跟随主请求就留空池子（此时回退旧的单模型路径）。
 * @param raw - 配置里的原始值。
 * @returns 去重、去空后的模型引用列表（保持用户顺序，轮转按此顺序）。
 */
export function parseModelPool(raw: unknown): ModelRef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const item of raw) {
    let provider = ''
    let model = ''
    if (typeof item === 'string') {
      const text = item.trim()
      const slash = text.indexOf('/')
      if (slash <= 0 || slash === text.length - 1) continue // 只认 provider/model
      provider = text.slice(0, slash).trim()
      model = text.slice(slash + 1).trim()
    } else if (item !== null && typeof item === 'object') {
      const o = item as { provider?: unknown; model?: unknown }
      provider = typeof o.provider === 'string' ? o.provider.trim() : ''
      model = typeof o.model === 'string' ? o.model.trim() : ''
    }
    if (provider.length === 0 || model.length === 0) continue
    const key = provider + '/' + model
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return out
}

/** 把模型引用格式化成 `provider/model`。 */
export function formatModelRef(ref: ModelRef): string {
  return ref.provider + '/' + ref.model
}

/**
 * 模型池：轮转取用、每模型并发、失败指数退避。
 *
 * 并发与退避是**每个模型各自**的：一个模型被限流时只挡住它自己，
 * 池子里其他模型照常接活——这正是"免费模型限制多"场景要的效果。
 */
export class ModelPool {
  private entries: PoolEntry[]
  /** 轮转游标（下次从哪个下标开始找）。 */
  private cursor = 0
  private readonly perModel: number
  private readonly backoffBase: number
  private readonly backoffMax: number
  private readonly now: () => number
  private readonly stats: PoolStatsLike | undefined

  /**
   * @param refs - 模型清单（空池子表示"未配置"）。
   * @param options - 并发与退避参数。
   */
  constructor(refs: readonly ModelRef[], options: ModelPoolOptions) {
    this.entries = refs.map((ref) => ({ ref, inFlight: 0, blockedUntil: 0, failures: 0, succeeded: 0, failed: 0, attempts: 0 }))
    this.perModel = Math.max(1, Math.floor(options.perModelConcurrency))
    this.backoffBase = Math.max(0, options.backoffBaseMs)
    this.backoffMax = Math.max(this.backoffBase, options.backoffMaxMs)
    this.now = options.now ?? (() => Date.now())
    this.stats = options.stats
  }

  /** 池子是否有模型（空池子 → 调用方回退单模型路径）。 */
  get size(): number {
    return this.entries.length
  }

  /** 配置指纹：模型清单 + 每模型并发（变化时调用方重建池子）。 */
  signature(): string {
    return this.entries.map((e) => formatModelRef(e.ref)).join('\u0000') + '\u0001' + String(this.perModel)
  }

  /**
   * 取下一个可用模型：从游标起顺序找第一个"未退避且未满载"的。
   * @returns 可用的模型引用；全部不可用时 undefined。
   */
  pick(): ModelRef | undefined {
    const n = this.entries.length
    if (n === 0) return undefined
    const at = this.now()
    for (let i = 0; i < n; i++) {
      const index = (this.cursor + i) % n
      const entry = this.entries[index]
      if (entry === undefined) continue
      if (entry.blockedUntil > at) continue
      if (entry.inFlight >= this.perModel) continue
      // 命中即推进游标：下一轮从它的下一个开始，保证真正轮转
      this.cursor = (index + 1) % n
      return entry.ref
    }
    return undefined
  }

  /** 占一个该模型的并发位（{@link pick} 之后调用）。 */
  acquire(ref: ModelRef): void {
    const entry = this.find(ref)
    if (entry) entry.inFlight++
  }

  /** 释放该模型的并发位。 */
  release(ref: ModelRef): void {
    const entry = this.find(ref)
    if (entry) entry.inFlight = Math.max(0, entry.inFlight - 1)
  }

  /** 记一次成功：清空该模型的退避等级。 */
  succeeded(ref: ModelRef): void {
    const entry = this.find(ref)
    if (!entry) return
    entry.succeeded++
    entry.failures = 0
    entry.blockedUntil = 0
    // 单次尝试序号归零：下次这个模型又从"不带 reasoningEffort"开始试
    entry.attempts = 0
    this.stats?.recordOk(formatModelRef(ref))
  }

  /**
   * 记一次失败：该模型进入指数退避，期间不被取用。
   * @param ref - 失败的模型。
   * @returns 本次退避时长（毫秒），供日志/诊断。
   */
  failed(ref: ModelRef): number {
    const entry = this.find(ref)
    if (!entry) return 0
    entry.failed++
    entry.failures++
    const delay = Math.min(this.backoffBase * Math.pow(2, entry.failures - 1), this.backoffMax)
    entry.blockedUntil = this.now() + delay
    this.stats?.recordFail(formatModelRef(ref))
    return delay
  }

  /**
   * 该模型在本轮任务里已尝试过几次（用于自动开关思考的重试）。
   * @param ref - 模型引用。
   * @returns 尝试次数（从 0 起）。
   */
  attemptsOf(ref: ModelRef): number {
    return this.find(ref)?.attempts ?? 0
  }

  /** 记录该模型又试了一次（自动开关思考据此决定下次是否带 reasoningEffort）。 */
  noteAttempt(ref: ModelRef): void {
    const entry = this.find(ref)
    if (entry) entry.attempts++
  }

  /**
   * 距下一个模型可用的等待时间（全部在退避/满载时用于安排重试）。
   * @returns 毫秒；无模型或已有可用模型时为 0。
   */
  nextWakeMs(): number {
    if (this.entries.length === 0) return 0
    const at = this.now()
    let best = Number.POSITIVE_INFINITY
    for (const entry of this.entries) {
      if (entry.inFlight >= this.perModel) continue // 满载：靠 release 触发，不靠定时器
      const wait = entry.blockedUntil - at
      if (wait <= 0) return 0 // 有可用模型
      if (wait < best) best = wait
    }
    return Number.isFinite(best) ? best : 0
  }

  /** 该模型当前是否在退避中（诊断用）。 */
  isBlocked(ref: ModelRef): boolean {
    const entry = this.find(ref)
    return entry !== undefined && entry.blockedUntil > this.now()
  }

  /** 快照（诊断/测试用）。 */
  snapshot(): PoolSnapshot {
    const at = this.now()
    return {
      size: this.entries.length,
      entries: this.entries.map((e) => ({
        provider: e.ref.provider,
        model: e.ref.model,
        inFlight: e.inFlight,
        blockedMs: Math.max(0, e.blockedUntil - at),
        failures: e.failures,
        succeeded: e.succeeded,
        failed: e.failed,
      })),
    }
  }

  private find(ref: ModelRef): PoolEntry | undefined {
    return this.entries.find((e) => e.ref.provider === ref.provider && e.ref.model === ref.model)
  }
}

/**
 * 池子管理器：按当前配置惰性重建池子，供**精炼队列与任务翻译共用**
 * （两者取同一个池子才能真"轮流"、并共享退避状态）。
 */
export class ModelPoolManager {
  private pool: ModelPool | undefined
  private key = ''

  /**
   * @param getRefs - 实时读取模型清单（设置改动即时生效）。
   * @param getPerModelConcurrency - 实时读取每模型并发。
   * @param stats - 跨进程累计统计（气泡状态色用；不传则只做内存计数）。
   */
  constructor(
    private readonly getRefs: () => ModelRef[],
    private readonly getPerModelConcurrency: () => number,
    private readonly stats?: PoolStatsLike,
  ) {}

  /** 当前池子（配置变化时重建，退避状态随之重置）。 */
  current(): ModelPool {
    const refs = this.getRefs()
    const perModel = Math.max(1, Math.floor(this.getPerModelConcurrency()))
    const key = refs.map(formatModelRef).join('\u0000') + '\u0001' + String(perModel)
    if (this.pool === undefined || key !== this.key) {
      this.pool = new ModelPool(refs, {
        perModelConcurrency: perModel,
        backoffBaseMs: POOL_DEFAULTS.backoffBaseMs,
        backoffMaxMs: POOL_DEFAULTS.backoffMaxMs,
        ...this.stats === undefined ? {} : { stats: this.stats },
      })
      this.key = key
    }
    return this.pool
  }
}
