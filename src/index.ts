import z from 'schemastery'
import { installDetect } from './host/stream.js'
import { ThinkStateStore } from './host/state.js'
import { installRpc } from './host/rpc.js'
import { installSettingsRpc } from './host/settings-rpc.js'
import { installFallback } from './host/fallback.js'
import { installSelfSummaryPrompt } from './host/self-summary.js'
import { installPersist } from './host/persist.js'
import { RefineQueue, type LlmLike } from './host/summarize/refine.js'
import { resolveConfig, DEFAULT_REFINE_PROMPT, DEFAULT_THINK_PROMPT, type ThinkSummaryConfig } from './host/config.js'
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
  /** 精炼最小段（token）：0 = 每个段都精炼（默认）。 */
  refineMinTokens: z.number().default(0),
  /** 'auto' = 跟随主请求 provider；或显式 provider id（可跨供应商精炼）。 */
  refineProvider: z.string().default('auto'),
  /** 'auto' = 所选 provider 的最小可用模型；或显式模型 id。 */
  refineModel: z.string().default('auto'),
  refinePrompt: z.string().default(DEFAULT_REFINE_PROMPT),
  /** 第二遍（整体摘要）的 system 提示词。 */
  refineThinkPrompt: z.string().default(DEFAULT_THINK_PROMPT),
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
      // 段摘要变了 → 触发第二遍（整体摘要）。防抖由队列负责，长思考只打一次。
      if (think && s) scheduleThink(sessionId, thinkId)
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
   * 触发第二遍（整体摘要）：把该 think 当前的分段摘要再喂一次模型。
   * 声明在队列之后、只在回调里调用（回调晚于构造执行）。
   */
  const scheduleThink = (sessionId: string, thinkId: string): void => {
    const think = store.get(sessionId)?.thinks.find((t) => t.id === thinkId)
    if (!think || think.segments.length === 0) return
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
  installRpc(ctx, store, () => getConfig(), refine, defaultModel)
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

