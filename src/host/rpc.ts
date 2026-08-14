import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike } from './ctx.js'

/**
 * M1/M4 RPC 双传输：
 *  - 发布版：webServer 路由 `/api/think-summary/state`（浏览器 fetch，响应式注册）
 *  - 动态插件开发版：全局 harness.handle（host.call）
 * 两者共存无害；谁可用就用谁。
 */
export function installRpc(ctx: CtxLike, store: ThinkStateStore): void {
  const harness = (globalThis as { harness?: { handle: (m: string, h: unknown) => unknown } }).harness
  if (harness && typeof harness.handle === 'function') {
    harness.handle('think-summary/state', (args: { sessionId?: string }) => {
      const sid = args?.sessionId
      if (typeof sid !== 'string' || sid.length === 0) return null
      return store.view(sid) ?? null
    })
  }

  whenWebServer(ctx, (webServer) => {
    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/state',
      handler: async (req: RouteReq, res: RouteRes) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sid = url.searchParams.get('sessionId')
          if (!sid) {
            writeJson(res, 400, { error: 'sessionId required' })
            return
          }
          writeJson(res, 200, { state: store.view(sid) ?? null })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}
