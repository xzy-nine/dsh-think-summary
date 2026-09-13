import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, readJsonBody, isLoopback, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike } from './ctx.js'
import type { ThinkSummaryConfig } from './config.js'

/**
 * 构建标记：随每次 Host 侧行为变更更新，出现在 `/api/think-summary/state`
 * 响应里，用来确认运行中的宿主究竟加载了哪一版代码（Host 模块被 ESM 缓存，
 * 补丁热重载只重建行、不重新 import 依赖，改 Host 代码必须重启 dsh）。
 */
export const BUILD = '2026-09-13-refine-error-reporting'

/** llm 服务的最小可用面（与 refine.ts 对齐，防御性类型）。 */
interface LlmLike {
  listProviders?(): Array<{ id?: string; name?: string }>
  listModels?(provider: string): Promise<Array<Record<string, unknown>>>
}

/** 精炼队列的最小可用面（「再试」入队）。 */
interface RefineQueueLike {
  enqueue(task: {
    sessionId: string
    thinkId: string
    segmentIndex: number
    text: string
    provider: string
    fallbackModel: string
  }): boolean
}

/** 「再试」请求体。 */
interface RefineRetryBody {
  sessionId?: string
  thinkId?: string
  segmentIndex?: number
  /** true = 该会话（或该 think）内所有可重试的未精炼段。 */
  all?: boolean
}

/**
 * M1/M4 RPC 双传输：
 *  - 发布版：webServer 路由 `/api/think-summary/state`（浏览器 fetch，响应式注册）。
 *    `sessionId` 可省略——缺省返回最近活跃会话的状态（侧边栏面板是 root
 *    作用域，没有 sessionId props）。响应带 `enabled`（插件总开关，供客户端
 *    门控：关闭时不渲染任何总结 UI）与 `paused`（全局暂停，供标题栏按钮显示）。
 *  - `/api/think-summary/models`：精炼供应商/模型下拉数据源——已注册供应商目录
 *    （llm.listProviders）、每个供应商的可用模型（llm.listModels，进程内缓存）
 *    以及当前默认选中模型（agentDefaultModel.currentSelection()），供设置页
 *    手动指定其他供应商的模型。
 *  - `/api/think-summary/pause`（POST，loopback-only）：切换全局暂停。
 *    暂停后不再检测/分段/精炼/兜底新思考，旧总结照常显示；与配置 enabled
 *    区分（enabled=false 隐藏全部 UI，paused=true 仅停止新产出）。
 *  - `/api/think-summary/refine`（POST，loopback-only）：「思考总结」视图页的
 *    **再试**——把指定段（或某个 think / 整个会话里所有未精炼段）重新入队精炼。
 *    段原文存在 state 里（`source`）；重启前落盘的旧记录没有原文，会以
 *    `refused` 计数返回，视图页据此禁用按钮。
 *  - 动态插件开发版：全局 harness.handle（host.call）
 */
export function installRpc(
  ctx: CtxLike,
  store: ThinkStateStore,
  getOptions?: () => ThinkSummaryConfig,
  refine?: RefineQueueLike | null,
  defaultModel?: () => { provider: string; model: string },
): void {
  const enabled = () => getOptions?.().enabled !== false
  // 模型目录缓存：供应商目录签名变化（注册/卸载）才重取，避免设置页每次打开重复查询
  let modelCacheSignature = '\u0001'
  let modelCache: { signature: string; modelsByProvider: Record<string, string[]> } = { signature: '', modelsByProvider: {} }
  const harness = (globalThis as { harness?: { handle: (m: string, h: unknown) => unknown } }).harness
  if (harness && typeof harness.handle === 'function') {
    harness.handle('think-summary/state', (args: { sessionId?: string }) => {
      const sid = typeof args?.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : store.lastActive
      return { enabled: enabled(), paused: store.paused, state: sid !== undefined ? store.view(sid) : undefined }
    })
  }

  whenWebServer(ctx, (webServer) => {
    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/state',
      handler: async (req: RouteReq, res: RouteRes) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sidParam = url.searchParams.get('sessionId')
          const sid = typeof sidParam === 'string' && sidParam.length > 0 ? sidParam : store.lastActive
          if (sid === undefined) {
            writeJson(res, 200, { build: BUILD, enabled: enabled(), paused: store.paused, state: null })
            return
          }
          writeJson(res, 200, { build: BUILD, enabled: enabled(), paused: store.paused, state: store.view(sid) ?? null })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/refine',
      handler: async (req: RouteReq, res: RouteRes) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
        if (!refine) return writeJson(res, 200, { ok: false, code: 'unavailable', message: '精炼队列不可用' })
        try {
          const parsed = await readJsonBody<RefineRetryBody>(req)
          const body: RefineRetryBody = parsed ?? {}
          const sid = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : store.lastActive
          if (sid === undefined) return writeJson(res, 200, { ok: false, code: 'unknown-session', message: '无会话' })
          const state = store.get(sid)
          if (!state) return writeJson(res, 200, { ok: false, code: 'unknown-session', message: '会话无思考总结' })

          // 重试用的 provider/model：实时流的 provider 不可得，用会话默认模型；
          // refineProvider 若被显式指定，精炼时会覆盖它（见 resolveRefineRoute）
          const fallback = defaultModel?.() ?? { provider: '', model: '' }

          // 选中目标段：单个（thinkId + segmentIndex）或 all（该 think / 整个会话）
          const targets: Array<{ thinkId: string; index: number }> = []
          for (const think of state.thinks) {
            if (body.thinkId !== undefined && think.id !== body.thinkId) continue
            for (const seg of think.segments) {
              if (body.all !== true && seg.index !== body.segmentIndex) continue
              // 已精炼 / 结构化摘要段（代码、表格）/ 主模型自产小结：不重试
              if (seg.refined || seg.skipReason || seg.kind === 'self') continue
              targets.push({ thinkId: think.id, index: seg.index })
            }
          }
          let queued = 0
          let refused = 0
          for (const target of targets) {
            const source = store.sourceOf(sid, target.thinkId, target.index)
            if (source === undefined) {
              refused++ // 旧记录没存原文（0.1.4 之前落盘），无法重跑
              continue
            }
            store.markRetry(sid, target.thinkId, target.index) // 清掉上次失败原因 → UI 回到"待精炼"
            refine.enqueue({
              sessionId: sid,
              thinkId: target.thinkId,
              segmentIndex: target.index,
              text: source,
              provider: fallback.provider || 'unknown',
              fallbackModel: fallback.model || '',
            })
            queued++
          }
          writeJson(res, 200, { ok: true, queued, refused, matched: targets.length })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/pause',
      handler: async (req: RouteReq, res: RouteRes) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
        try {
          const body = await readJsonBody<{ paused?: boolean }>(req)
          store.paused = body?.paused === true
          writeJson(res, 200, { ok: true, paused: store.paused })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/models',
      handler: async (req: RouteReq, res: RouteRes) => {
        try {
          // 当前默认选中模型（设置页"自动"时显示；也是 auto provider 的口径）
          const sel = (ctx.get('agentDefaultModel') as
            | { currentSelection?: () => { provider?: string; model?: string } }
            | undefined)?.currentSelection?.()
          const provider = sel?.provider ?? ''
          const current = sel?.model ?? ''
          const llm = ctx.get('llm') as LlmLike | undefined

          // 已注册供应商目录（可手动选中的"其他供应商"）
          let providers: Array<{ id: string; name: string }> = []
          try {
            const raw = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
            providers = (Array.isArray(raw) ? raw : [])
              .map((p) => ({
                id: p && typeof p.id === 'string' ? p.id : '',
                name: p && typeof p.name === 'string' && p.name.length > 0 ? p.name : '',
              }))
              .filter((p) => p.id.length > 0)
          } catch {
            /* 目录不可用：下拉只剩"自动" */
          }
          // 当前会话 provider 不在已注册目录时也纳入（保证 auto 的目标可见）
          if (provider && !providers.some((p) => p.id === provider)) {
            providers = [{ id: provider, name: provider }, ...providers]
          }

          // 逐供应商取模型目录（进程内缓存：注册表变化时才重取）
          const signature = providers.map((p) => p.id).join('\u0000')
          if (signature !== modelCacheSignature) {
            const modelsByProvider: Record<string, string[]> = {}
            for (const p of providers) {
              modelsByProvider[p.id] = await listModelIds(llm, p.id)
            }
            modelCache = { signature, modelsByProvider }
          }
          writeJson(res, 200, {
            ok: true,
            provider,
            current,
            providers,
            modelsByProvider: modelCache.modelsByProvider,
            // 兼容旧客户端：当前 provider 的扁平列表
            models: modelCache.modelsByProvider[provider] ?? [],
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}

/** 取一个 provider 的模型 id 列表（目录不可用/失败 → 空列表）。 */
async function listModelIds(llm: LlmLike | undefined, provider: string): Promise<string[]> {
  if (!provider || !llm || typeof llm.listModels !== 'function') return []
  try {
    const list = await llm.listModels(provider)
    return (Array.isArray(list) ? list : [])
      .map((m) => (m && typeof m.id === 'string' ? m.id : undefined))
      .filter((x): x is string => Boolean(x))
  } catch {
    return []
  }
}
