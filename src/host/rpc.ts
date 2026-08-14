import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike } from './ctx.js'

/**
 * M1/M4 RPC 双传输：
 *  - 发布版：webServer 路由 `/api/think-summary/state`（浏览器 fetch，响应式注册）。
 *    `sessionId` 可省略——缺省返回最近活跃会话的状态（侧边栏面板是 root
 *    作用域，没有 sessionId props）。
 *  - 动态插件开发版：全局 harness.handle（host.call）
 */
export function installRpc(ctx: CtxLike, store: ThinkStateStore): void {
  const harness = (globalThis as { harness?: { handle: (m: string, h: unknown) => unknown } }).harness
  if (harness && typeof harness.handle === 'function') {
    harness.handle('think-summary/state', (args: { sessionId?: string }) => {
      const sid = typeof args?.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : store.lastActive
      return (sid !== undefined ? store.view(sid) : undefined) ?? null
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
            writeJson(res, 200, { state: null })
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
