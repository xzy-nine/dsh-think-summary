/**
 * 持久化模块（M5）：
 *  - 思考总结保存到 `~/.dsh/dsh-think-summary.json`（与 dsh-ssh 同目录惯例），
 *    重启 dsh 后仍可查看历史总结；配置 `persistEnabled` 开关（默认开）。
 *  - 写盘防抖（2s）：begin/end/push/清理等状态变更后合并写，避免高频 IO。
 *  - 自动清理：配置 `autoCleanArchived` + `autoCleanArchivedDays`，定时清理
 *    "已归档"（非活跃且空闲超过 N 天）会话的总结。
 *  - 手动清理 RPC：POST /api/think-summary/clear-archived { graceMs? }。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ThinkStateStore } from './state.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'
import { whenWebServer, writeJson, isLoopback, type RouteReq, type RouteRes } from './webserver.js'

const FILE_NAME = 'dsh-think-summary.json'
/** 写盘防抖（毫秒）。 */
const SAVE_DEBOUNCE_MS = 2000
/** 自动清理检查周期（毫秒）。 */
const CLEAN_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface PersistHandle {
  /** 立即写盘（幂等）。 */
  flush(): void
  /** 手动清理已归档会话；返回移除数。 */
  clearArchived(graceMs?: number): number
}

export function installPersist(
  ctx: CtxLike,
  store: ThinkStateStore,
  getOptions: () => ThinkSummaryConfig,
): PersistHandle {
  const file = join(homedir(), '.dsh', FILE_NAME)

  const readSaved = (): ReturnType<ThinkStateStore['exportAll']> | undefined => {
    try {
      if (!existsSync(file)) return undefined
      const raw = readFileSync(file, 'utf8')
      const json = JSON.parse(raw)
      return json && Array.isArray(json.sessions) ? json.sessions : undefined
    } catch {
      return undefined // 损坏/不可读：忽略，不阻断启动
    }
  }

  // 启动加载：仅当持久化开启（默认开）。加载后主动落盘一次，统一格式。
  const initial = getOptions().persistEnabled !== false
  if (initial) {
    store.loadAll(readSaved())
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const writeNow = () => {
    saveTimer = null
    try {
      if (getOptions().persistEnabled === false) return // 关闭持久化：不写盘
      const dir = join(homedir(), '.dsh')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload = { version: 1, sessions: store.exportAll() }
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      /* 写盘失败仅影响持久化，不影响运行时 */
    }
  }
  const scheduleSave = () => {
    if (getOptions().persistEnabled === false) return
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS)
  }

  // 状态变更 → 防抖写盘
  const offChange = store.onChange(scheduleSave)

  // 自动清理：定时检查"已归档"会话（非活跃 + 空闲超配置天数）
  const timer = ctx.get('timer') as { interval?: (fn: () => void, ms: number) => unknown } | undefined
  const autoClean = () => {
    const opts = getOptions()
    if (opts.autoCleanArchived !== true) return
    const days = typeof opts.autoCleanArchivedDays === 'number' && opts.autoCleanArchivedDays > 0
      ? opts.autoCleanArchivedDays
      : 30
    const removed = store.clearArchived(days * DAY_MS)
    if (removed > 0) scheduleSave() // 清理后落盘
  }
  const offInterval = timer?.interval?.(autoClean, CLEAN_INTERVAL_MS)

  // 生命周期清理：卸载时立即写盘并释放监听/定时器
  const dispose = () => {
    offChange?.()
    if (typeof offInterval === 'function') offInterval()
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    writeNow()
  }
  if (typeof ctx.effect === 'function') ctx.effect(dispose)

  // 手动清理 RPC
  whenWebServer(ctx, (webServer) => {
    webServer.register({
      kind: 'exact',
      path: '/api/think-summary/clear-archived',
      handler: async (req: RouteReq, res: RouteRes) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
        try {
          let graceMs = 0
          const raw = req as RouteReq & { on?: (ev: string, cb: (chunk?: unknown) => void) => unknown }
          if (typeof raw.on === 'function') {
            let body = ''
            await new Promise<void>((resolve) => {
              raw.on?.('data', (chunk: unknown) => {
                if (typeof chunk === 'string') body += chunk
                else if (chunk && typeof (chunk as { toString?: (enc?: string) => string }).toString === 'function') {
                  body += (chunk as { toString: (enc?: string) => string }).toString('utf8')
                }
              })
              raw.on?.('end', () => resolve())
              raw.on?.('error', () => resolve())
            })
            try {
              const parsed = JSON.parse(body) as { graceMs?: number }
              if (typeof parsed?.graceMs === 'number' && parsed.graceMs > 0) graceMs = parsed.graceMs
            } catch {
              /* 无 body 或非法 JSON：按全清理 */
            }
          }
          const removed = store.clearArchived(graceMs)
          if (removed > 0) scheduleSave()
          writeJson(res, 200, { ok: true, removed, persisted: getOptions().persistEnabled !== false })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })

  return {
    flush: writeNow,
    clearArchived: (graceMs = 0) => {
      const n = store.clearArchived(graceMs)
      if (n > 0) scheduleSave()
      return n
    },
  }
}
