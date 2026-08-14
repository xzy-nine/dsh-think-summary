import type { CtxLike } from './ctx.js'

/**
 * webServer 服务可能晚于插件 apply 挂载（bundle 加载顺序），
 * 路由注册必须响应式：先试一次，未就绪则监听 `internal/service`
 * 在 webServer 出现时补注册。回调在服务就绪后恰好执行一次。
 */
export function whenWebServer(ctx: CtxLike, register: (webServer: { register: (route: unknown) => unknown }) => void): void {
  let done = false
  const tryRegister = () => {
    if (done) return
    const webServer = ctx.get('webServer') as
      | { register: (route: unknown) => unknown }
      | undefined
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      register(webServer)
      done = true
    } catch {
      /* 注册失败不致命：下次服务事件再试 */
    }
  }
  tryRegister()
  ctx.on('internal/service', (name: unknown) => {
    if (name === 'webServer') tryRegister()
  })
}

/** 最小路由请求/响应结构面（与 dsh-web-server 的 WebRoute 对齐）。 */
export interface RouteReq {
  method?: string
  url?: string
  socket?: { remoteAddress?: string }
}

export interface RouteRes {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

export function writeJson(res: RouteRes, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** loopback 守卫：拒绝非本机来源（浏览器同源 + 远程浏览器无持久化设置）。 */
export function isLoopback(req: RouteReq): boolean {
  const addr = req.socket?.remoteAddress
  return addr === undefined || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
