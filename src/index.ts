import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { installDetect } from './host/stream.js'
import { ThinkStateStore } from './host/state.js'
import { installRpc } from './host/rpc.js'
import { installSettingsRpc } from './host/settings-rpc.js'
import { installFallback } from './host/fallback.js'
import { RefineQueue, type LlmLike } from './host/summarize/refine.js'
import { resolveConfig, type ThinkSummaryConfig } from './host/config.js'
import type { CtxLike } from './host/ctx.js'

export const name = 'dsh-think-summary'

/** 设置命名空间（web 设置表面与客户端共同拼写）。 */
const NS = settingsNamespace('think-summary')

/** 设置 schema（schemastery）；loader 应用默认值，设置页编辑同一命名空间。 */
const Config = z.object({
  enabled: z.boolean().default(true),
  thinkThresholdTokens: z.number().default(2000),
  filterNonAgentLoop: z.boolean().default(true),
  segmentMinTokens: z.number().default(1500),
  segmentMaxTokens: z.number().default(3000),
  refineEnabled: z.boolean().default(true),
  refineMaxInputTokens: z.number().default(1500),
  refineOutputTokens: z.number().default(1024),
  refineModel: z.string().default('auto'),
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
 * 配置：installSettingsSection 注册命名空间；setSource 让设置页改动实时生效
 * （阈值/开关在每次流开始时读取）。
 */
export function apply(ctx: CtxLike, config: ThinkSummaryConfig = {}) {
  let getConfig: () => ThinkSummaryConfig = () => resolveConfig(config)
  const store = new ThinkStateStore()

  const refine = new RefineQueue(
    () => getConfig(),
    () => ctx.get('llm') as LlmLike | undefined,
    (sessionId, segmentIndex, refinedSummary) => {
      const s = store.get(sessionId)
      const seg = s?.segments[segmentIndex]
      if (seg) {
        seg.summary = refinedSummary
        seg.refined = true
        s.updatedAt = Date.now()
      }
    },
  )

  installDetect(ctx, store, () => getConfig(), refine)
  installRpc(ctx, store)
  installSettingsRpc(ctx, store)
  installFallback(ctx, store, () => getConfig())

  installSettingsSection(ctx as never, NS, Config, resolveConfig(config), {
    setSource: (source: unknown) => {
      getConfig = source as () => ThinkSummaryConfig
    },
    onChange: () => {
      /* 阈值/开关按流读取，设置即时生效 */
    },
  })
}

export { Config }
