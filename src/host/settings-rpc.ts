import { whenWebServer, writeJson, readJsonBody, isLoopback, type RouteReq, type RouteRes } from './webserver.js'
import type { CtxLike, SettingsServiceLike } from './ctx.js'

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

interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

export function installSettingsRpc(ctx: CtxLike): void {
  const settings = (): SettingsServiceLike | undefined => ctx.get('settings') as SettingsServiceLike | undefined

  /** 命名空间视图：{ ns, value, base, user, revision, writable }。 */
  const namespaceView = (s: SettingsServiceLike) => {
    const descriptor = s.describe({ redactSecrets: true }).find((d) => String(d.ns) === NS_STRING)
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
        const body = await readJsonBody<{ ops?: SettingsOp[]; expectedRevision?: number }>(req)
        if (body === null || !Array.isArray(body.ops) || body.ops.length === 0) {
          return writeJson(res, 400, { ok: false, code: 'rejected', message: 'invalid mutate payload' })
        }
        try {
          await s.mutate(NS_STRING, body.ops, body.expectedRevision)
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
