import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike } from './ctx.js'
import type { ThinkSummaryConfig } from './config.js'

/** llm 服务的最小可用面（与 refine.ts 对齐，防御性类型）。 */
interface LlmLike {
  listModels?(provider: string): Promise<Array<Record<string, unknown>>>
}

/**
 * M1/M4 RPC 双传输：
 *  - 发布版：webServer 路由 `/api/think-summary/state`（浏览器 fetch，响应式注册）。
 *    `sessionId` 可省略——缺省返回最近活跃会话的状态（侧边栏面板是 root
 *    作用域，没有 sessionId props）。响应带 `enabled`（插件总开关，供客户端
 *    门控：关闭时不渲染任何总结 UI）。
 *  - `/api/think-summary/models`：精炼模型下拉数据源——当前默认选中模型
 *    （agentDefaultModel.currentSelection()）与其 provider 的可用模型列表
 *    （llm.listModels），供设置页下拉菜单自动识别。
 *  - 动态插件开发版：全局 harness.handle（host.call）
 */
export function installRpc(ctx: CtxLike, store: ThinkStateStore, getOptions?: () => ThinkSummaryConfig): void {
  const enabled = () => getOptions?.().enabled !== false
  const harness = (globalThis as { harness?: { handle: (m: string, h: unknown) => unknown } }).harness
  if (harness && typeof harness.handle === 'function') {
    harness.handle('think-summary/state', (args: { sessionId?: string }) => {
      const sid = typeof args?.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : store.lastActive
      return { enabled: enabled(), state: sid !== undefined ? store.view(sid) : undefined }
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
            writeJson(res, 200, { enabled: enabled(), state: null })
            return
          }
          writeJson(res, 200, { enabled: enabled(), state: store.view(sid) ?? null })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/models',
      handler: async (req: RouteReq, res: RouteRes) => {
        try {
          // 当前默认选中模型（设置页"自动"时显示）
          const sel = (ctx.get('agentDefaultModel') as
            | { currentSelection?: () => { provider?: string; model?: string } }
            | undefined)?.currentSelection?.()
          const provider = sel?.provider ?? ''
          const current = sel?.model ?? ''
          // 该 provider 的可用模型列表（下拉选项）
          let models: string[] = []
          const llm = ctx.get('llm') as LlmLike | undefined
          if (provider && llm && typeof llm.listModels === 'function') {
            try {
              const list = await llm.listModels(provider)
              models = (Array.isArray(list) ? list : [])
                .map((m) => (m && typeof m.id === 'string' ? m.id : undefined))
                .filter((x): x is string => Boolean(x))
            } catch {
              /* 目录不可用：下拉只剩"自动" */
            }
          }
          writeJson(res, 200, { ok: true, provider, current, models })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}
