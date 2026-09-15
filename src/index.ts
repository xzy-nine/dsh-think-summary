import z from 'schemastery'
import { installDetect } from './host/stream.js'
import { ThinkStateStore } from './host/state.js'
import { installRpc } from './host/rpc.js'
import { installSettingsRpc } from './host/settings-rpc.js'
import { installFallback } from './host/fallback.js'
import { installSelfSummaryPrompt } from './host/self-summary.js'
import { installPersist } from './host/persist.js'
import { createTodoTranslator } from './host/todo.js'
import { ModelPoolManager, parseModelPool } from './host/pool.js'
import { PoolStats } from './host/pool-stats.js'
import { RefineQueue, type LlmLike } from './host/summarize/refine.js'
import {
  resolveConfig,
  DEFAULT_REFINE_PROMPT,
  DEFAULT_THINK_PROMPT,
  DEFAULT_TODO_PROMPT,
  type ThinkSummaryConfig,
} from './host/config.js'
import type { CtxLike, SettingsServiceLike } from './host/ctx.js'

export const name = 'dsh-think-summary'

/**
 * 设置命名空间（web 设置表面与客户端共同拼写）。
 * 0.1.5 起 `@deepseek-ai/dsh-settings` 不再导出 settingsNamespace（该品牌类型
 * 已下线），命名空间就是普通字符串，服务端由 settings 服务自行校验拼写。
 */
const NS = 'think-summary'

/** 设置 schema（schemastery）；loader 应用默认值，设置页编辑同一命名空间。 */
const Config = z.object({
  /** 插件总开关：关闭后不检测、不精炼、不注入提示词，客户端也不渲染任何总结 UI。 */
  enabled: z.boolean().default(true),
  thinkThresholdTokens: z.number().default(0),
  filterNonAgentLoop: z.boolean().default(true),
  segmentMinTokens: z.number().default(1500),
  segmentMaxTokens: z.number().default(3000),
  refineEnabled: z.boolean().default(true),
  refineMaxInputTokens: z.number().default(800),
  refineOutputTokens: z.number().default(512),
  /**
   * 精炼请求显式关闭思考（`reasoningEffort: 'off'`）。
   *
   * 供应商必须声明该档位才有效（`compat.supportsReasoningEffort: true` +
   * 模型 `reasoningEfforts.off`）；未声明时请求以 UNSUPPORTED_REASONING_EFFORT
   * 明确失败——静默沿用供应商默认会让默认思考的模型继续烧预算。
   */
  refineDisableReasoning: z.boolean().default(true),
  /**
   * 精炼模型池：`"provider/model"` 字符串数组（多模型轮转）。
   * 非空时摘要与翻译轮流从池子里取模型，并发按每模型计算。
   */
  refineModels: z.array(z.string()).default([]),
  /** 每个模型的并发上限（池子模式；免费模型建议 1）。 */
  poolPerModelConcurrency: z.number().default(1),
  /** 单个精炼任务在池子里的最大尝试轮数（每轮可能换模型）。 */
  poolMaxAttempts: z.number().default(3),
  /** 精炼最小段（token）：0 = 每个段都精炼（默认）。 */
  refineMinTokens: z.number().default(0),
  /** 'auto' = 跟随主请求 provider；或显式 provider id（可跨供应商精炼）。 */
  refineProvider: z.string().default('auto'),
  /** 'auto' = 所选 provider 的最小可用模型；或显式模型 id。 */
  refineModel: z.string().default('auto'),
  refinePrompt: z.string().default(DEFAULT_REFINE_PROMPT),
  /** 第二遍（整体摘要）的 system 提示词。 */
  refineThinkPrompt: z.string().default(DEFAULT_THINK_PROMPT),
  /** 任务看板：看板上「翻译为中文」按钮用的 system 提示词（手动触发）。 */
  todoTranslatePrompt: z.string().default(DEFAULT_TODO_PROMPT),
  refineConcurrency: z.number().default(3),
  refineTimeout: z.number().default(60),
  codeBlockMode: z.union([z.const('ignore'), z.const('keep-skip'), z.const('keep-refine')]).default('ignore'),
  tableMode: z.union([z.const('ignore'), z.const('keep-skip'), z.const('keep-refine')]).default('ignore'),
  refineTrim: z.union([z.const('headtail'), z.const('tail'), z.const('full')]).default('headtail'),
  selfSummary: z.union([z.const('off'), z.const('prompt')]).default('off'),
  persistEnabled: z.boolean().default(true),
  autoCleanArchived: z.boolean().default(false),
  autoCleanArchivedDays: z.number().default(30),
})

/**
 * Plugin root。Host 半面；web 客户端半面在 ./client（ModuleLoader bundle，
 * 经 dsh.client 声明装载）。
 *
 * 安装方式（多路通用）：
 *  - dsh plugin --profile <name> add link:<repo-path>   （本地开发，符号链接）
 *  - dsh plugin --profile <name> add dsh-think-summary    （npm 包）
 *  - 手动 cordis.yml 行：- path: <repo> / - pkg: dsh-think-summary（纯 Host）
 *
 * 配置：经 ctx 上的 settings 服务注册命名空间（installSection）；setSource 让
 * 设置页改动实时生效（阈值/开关在每次流开始时读取）。不 import
 * `@deepseek-ai/dsh-settings`：profile 的行解析不到该包（外部插件只解析自身与
 * $DSH_HOME 的 node_modules），且 0.1.5 已把 installSection 收进服务方法。
 */
export function apply(ctx: CtxLike, config: ThinkSummaryConfig = {}) {
  let getConfig: () => ThinkSummaryConfig = () => resolveConfig(config)
  const store = new ThinkStateStore()

  // 模型池：**精炼与任务翻译共用同一个**，这样两者才会真正互相轮转，
  // 且一个模型的退避对两者同时生效（否则翻译会绕过精炼的退避继续打同一个模型）。
  // 统计跨进程持久化——气泡状态色要跨重启累计才有意义（否则永远显示不出红/绿）。
  const poolStats = new PoolStats()
  const pools = new ModelPoolManager(
    () => parseModelPool(getConfig().refineModels),
    () => getConfig().poolPerModelConcurrency ?? 1,
    poolStats,
  )

  const refine = new RefineQueue(
    () => {
      const c = getConfig()
      return {
        enabled: c.refineEnabled,
        maxInputTokens: c.refineMaxInputTokens,
        outputTokens: c.refineOutputTokens,
        // provider 'auto' = 跟随主请求 provider；显式值可跨供应商（设置页选择）
        provider: c.refineProvider,
        model: c.refineModel,
        refinePrompt: c.refinePrompt,
        thinkPrompt: c.refineThinkPrompt,
        refineConcurrency: c.refineConcurrency,
        refineTimeout: c.refineTimeout,
        trim: c.refineTrim,
        disableReasoning: c.refineDisableReasoning,
        poolPerModelConcurrency: c.poolPerModelConcurrency,
        poolMaxAttempts: c.poolMaxAttempts,
      }
    },
    () => ctx.get('llm') as LlmLike | undefined,
    (sessionId, thinkId, segmentIndex, refinedSummary, refineTokens) => {
      const s = store.get(sessionId)
      const think = s?.thinks.find((t) => t.id === thinkId)
      const seg = think?.segments[segmentIndex]
      if (seg && s) {
        seg.summary = refinedSummary
        seg.refined = true
        seg.unrefinedReason = undefined // 已精炼，清除原因
        seg.refineTokens = refineTokens
        s.updatedAt = Date.now()
      }
      // 实时路径的 think（active=true）不在这里触发——等思维链真正结束
      // （store.endThink → onThinkEnd）汇总一次，否则一次 N 段思考会打 N 次整体摘要。
      // 兜底路径的 think 生来 active=false（事后补跑，没有"结束"事件），
      // 在这里触发；once 守卫保证它也只汇总一次。
      if (think && think.active !== true) scheduleThink(sessionId, thinkId)
    },
    // 精炼失败/超时：把原因写回段（UI 显示"未精炼原因"）
    (sessionId, thinkId, segmentIndex, reason) => {
      const s = store.get(sessionId)
      const think = s?.thinks.find((t) => t.id === thinkId)
      const seg = think?.segments[segmentIndex]
      if (seg && s) {
        seg.unrefinedReason = '精炼失败：' + reason
        s.updatedAt = Date.now()
      }
    },
    // 第二遍结果：整次思考的一句话动向（UI 常显这一句，段列表默认折叠）
    (sessionId, thinkId, summary, tokens) => {
      store.setThinkSummary(sessionId, thinkId, summary, tokens)
    },
    // 第二遍失败：只记原因，不影响段摘要
    (sessionId, thinkId, reason) => {
      store.setThinkSummaryFailure(sessionId, thinkId, '整体摘要失败：' + reason)
    },
  )

  /**
   * 触发第二遍（整体摘要）：把该 think 的分段摘要再喂一次模型，得到一句整体动向。
   *
   * **只在思维链结束后触发一次**（订阅 `store.onThinkEnd`），而不是每段精炼后触发——
   * 否则一次 N 段的思考会打 N 次整体摘要，等于"总总结次数 = 段数"（用户明确否掉）。
   *
   * 结束时刻的问题：最后一段的精炼可能还在途（思维链刚结束、精炼尚未回来）。
   * 此时若立刻汇总，会漏掉最后一段的精炼结果。所以：
   *  - 还有在途精炼 → 延迟重试几次，等它们落定；
   *  - 重试上限内仍未落定 → 用当前已有的段摘要汇总（宁可少一段，也不无限等）。
   *
   * **只有 ≥2 段才跑**：单段时整体摘要几乎是那段摘要的复述，纯浪费一次调用。
   */
  const THINK_WAIT_MS = 700
  const THINK_WAIT_TRIES = 6
  /**
   * 已经汇总过的 think（键 `sessionId\0thinkId`）。
   *
   * 兜底路径的段精炼是逐个回调的，每次都会走到 scheduleThink；没有这个守卫
   * 就会打 N 次整体摘要——这正是要修的问题。实时路径靠 `onThinkEnd`
   * 的"活跃→结束"只触发一次，这里再加一层保险。
   */
  const thinkDone = new Set<string>()
  const scheduleThink = (sessionId: string, thinkId: string, tries = 0): void => {
    const key = sessionId + '\u0000' + thinkId
    if (thinkDone.has(key)) return // 已汇总过：绝不重复
    const think = store.get(sessionId)?.thinks.find((t) => t.id === thinkId)
    if (!think) return
    if (think.segments.length < 2) return // 单段：不跑第二遍
    // 还有该 think 的在途段精炼 → 稍后重试，等最后几段落定
    if (refine.hasPendingFor(sessionId, thinkId) && tries < THINK_WAIT_TRIES) {
      const t = setTimeout(() => scheduleThink(sessionId, thinkId, tries + 1), THINK_WAIT_MS)
      // 不阻止进程退出（dsh 被关闭时这个等待无意义）
      if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref?: () => void }).unref?.()
      return
    }
    // 落定后才标记"已汇总"（等待期间的重入由 thinkDone 之前的重试逻辑处理）
    thinkDone.add(key)
    const fallback = defaultModelOf()
    refine.enqueueThink({
      sessionId,
      thinkId,
      provider: fallback.provider || 'unknown',
      fallbackModel: fallback.model,
      // 已精炼的用精炼结果，未精炼的用启发式摘要（整体摘要仍覆盖全段）
      segments: think.segments.map((x) => x.summary),
    })
  }

  // 思维链结束 → 打一次整体摘要（唯一触发点）
  store.onThinkEnd((sessionId, thinkId) => { scheduleThink(sessionId, thinkId) })

  // 兜底路径精炼、视图页「再试」、整体摘要用的默认模型（实时请求的 provider 在这几处不可得）
  const defaultModelOf = () => {
    try {
      const sel = (ctx.get('agentDefaultModel') as
        | { currentSelection?: () => { provider?: string; model?: string } }
        | undefined)?.currentSelection?.()
      return { provider: sel?.provider ?? '', model: sel?.model ?? '' }
    } catch {
      return { provider: '', model: '' }
    }
  }
  const defaultModel = defaultModelOf

  installDetect(ctx, store, () => getConfig(), refine)
  const todoTranslate = createTodoTranslator(() => getConfig(), () => ctx.get('llm') as LlmLike | undefined, defaultModel, pools)
  refine.usePool(pools)
  installRpc(
    ctx, store, () => getConfig(), refine, defaultModel,
    (contents, sessionId) => todoTranslate.translate(contents, sessionId),
    () => poolStats.all(),
  )
  installSettingsRpc(ctx)
  installFallback(ctx, store, () => getConfig(), refine, defaultModel)

  // 持久化：思考总结保存到磁盘（重启后仍显示）+ 已归档会话清理（手动/自动）
  installPersist(ctx, store, () => getConfig())

  // 主模型自产小结：按 selfSummary 配置注入/卸载提示词段（设置变更即时同步）
  const syncSelfPrompt = installSelfSummaryPrompt(ctx, () => getConfig())

  // 设置命名空间注册（可选服务：无 settings 时退回组合 config，功能不受影响）。
  // 服务可能晚于本插件 apply 挂载，故先试一次，再挂 cordis inject 回调等待出现；
  // 回调随插件 fiber 回收，无需手动清理。
  let registered = false
  const registerSettings = () => {
    if (registered) return
    const settings = ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) return
    // owner 恒为本插件的 ctx：installSection 的清理 effect 必须挂在插件 fiber 上
    // （依赖回调传入的子 ctx 会随该回调结束而销毁，导致命名空间被立刻注销）
    settings.installSection(ctx, NS, Config, resolveConfig(config), {
      setSource: (source) => {
        getConfig = source as () => ThinkSummaryConfig
      },
      onChange: () => {
        syncSelfPrompt()
        /* 阈值/开关按流读取，设置即时生效 */
      },
    })
    registered = true
  }
  registerSettings()
  if (!registered && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], () => {
        registerSettings()
      })
    } catch {
      /* inject 不可用：仅组合 config 生效 */
    }
  }
}

export { Config }



