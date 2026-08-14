import type { ThinkStateStore } from './state.js'
import { whenWebServer, writeJson, isLoopback, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike } from './ctx.js'

/**
 * 自建设置桥（M4 部署修正）：
 *
 * 官方设置桥（dsh-host-apiproxy）只把白名单命名空间服务给浏览器，第三方
 * 命名空间一律 `settings-not-exposed`；web-ui 组的桥接也只认家族清单。
 * 因此本插件自带 loopback-only 设置桥（与家族插件同一套路，但两端归己）：
 *   POST /api/think-summary/settings/describe —— 命名空间视图（value/base/user/revision/writable）
 *   POST /api/think-summary/settings/mutate   —— 逐字段 set/unset（revision 围栏）
 * 直连 Host settings 服务，绕开一切白名单。
 */

const NS_STRING = 'think-summary'

/** 设置服务的结构面（运行时真对象更大，这里只声明用到的）。 */
interface SettingsLike {
  writable?: boolean
  describe?: (options?: { redactSecrets?: boolean }) => Array<{
    ns: unknown
    value?: unknown
    base?: unknown
    user?: unknown
    revision?: number
  }>
  get?: (ns: unknown) => unknown
  mutate?: (ns: unknown, ops: unknown, expectedRevision?: number) => Promise<unknown>
}

interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

export function installSettingsRpc(ctx: CtxLike, store: ThinkStateStore): void {
  const settings = (): SettingsLike | undefined => ctx.get('settings') as SettingsLike | undefined

  const readBody = async (req: RouteReq): Promise<{ ops?: SettingsOp[]; expectedRevision?: number } | null> => {
    // 读 IncomingMessage 的 data 流（dsh-web-server 的 handler 收到原始请求对象）。
    const raw = req as RouteReq & { on?: (ev: string, cb: (chunk?: unknown) => void) => unknown }
    if (typeof raw.on !== 'function') return null
    let body = ''
    await new Promise<void>((resolve, reject) => {
      raw.on?.('data', (chunk: unknown) => {
        if (typeof chunk === 'string') body += chunk
        else if (chunk && typeof (chunk as { toString?: (enc?: string) => string }).toString === 'function') {
          body += (chunk as { toString: (enc?: string) => string }).toString('utf8')
        }
      })
      raw.on?.('end', () => resolve())
      raw.on?.('error', () => reject(new Error('body read failed')))
    })
    try {
      return JSON.parse(body) as { ops?: SettingsOp[]; expectedRevision?: number }
    } catch {
      return null
    }
  }

  /** 命名空间视图：{ ns, value, base, user, revision, writable }。 */
  const namespaceView = (s: SettingsLike) => {
    const descriptor = (s.describe?.({ redactSecrets: true }) ?? []).find((d) => String(d.ns) === NS_STRING)
    if (descriptor === undefined) return undefined
    return {
      ns: NS_STRING,
      value: descriptor.value,
      base: descriptor.base,
      user: descriptor.user,
      revision: descriptor.revision ?? 0,
      writable: s.writable !== false,
    }
  }

  whenWebServer(ctx, (webServer) => {
    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/settings/describe',
      handler: async (req: RouteReq, res: RouteRes) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
        const s = settings()
        if (!s) return writeJson(res, 200, { ok: true, value: { namespaces: [], writable: false } })
        const view = namespaceView(s)
        writeJson(res, 200, { ok: true, value: { namespaces: view ? [view] : [], writable: view?.writable ?? false } })
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/settings/mutate',
      handler: async (req: RouteReq, res: RouteRes) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
        const s = settings()
        if (!s) return writeJson(res, 200, { ok: false, code: 'internal', message: 'settings service is absent' })
        const body = await readBody(req)
        if (body === null || !Array.isArray(body.ops) || body.ops.length === 0) {
          return writeJson(res, 400, { ok: false, code: 'rejected', message: 'invalid mutate payload' })
        }
        try {
          await s.mutate?.(NS_STRING, body.ops, body.expectedRevision)
          const view = namespaceView(s)
          if (!view) return writeJson(res, 200, { ok: false, code: 'internal', message: 'namespace disposed after mutate' })
          writeJson(res, 200, { ok: true, value: view })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            code: 'rejected',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
  })
}
