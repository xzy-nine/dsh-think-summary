/**
 * 持久化模块（M5，v2）——对齐 dsh-pet 等家族插件的可靠存储实践：
 *  - 单文件 `~/.dsh/dsh-think-summary.json`（$DSH_HOME 惯例）。
 *  - **原子写**：先写 `*.tmp` 再 `renameSync` 覆盖（防写一半损坏；参照 pet.json）。
 *  - **同步立即写**：状态每次变更（begin/end/push/清理）都同步落盘，
 *    不依赖防抖/进程退出钩子——dsh 强杀也不丢最后一条总结（参照 pet 的
 *    "interaction/config 变更即写"）。
 *  - **容错读**：损坏/不可读 → 空（不阻断启动）。
 *  - 自动清理：`autoCleanArchived` + `autoCleanArchivedDays`，定时清理
 *    "已归档"（非活跃且空闲超过 N 天）会话。
 *  - 手动清理 RPC：POST /api/think-summary/clear-archived { graceMs? }，
 *    **默认保留最近 24h 的有段会话**（graceMs 缺省 = 1 天），防止误清刚结束的总结。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ThinkStateStore } from './state.js'
import type { ThinkSummaryConfig } from './config.js'
import type { CtxLike } from './ctx.js'
import { whenWebServer, writeJson, readJsonBody, isLoopback, type RouteReq, type RouteRes } from './webserver.js'

const FILE_NAME = 'dsh-think-summary.json'
/** 自动清理检查周期（毫秒）。 */
const CLEAN_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** 手动清理默认宽限：保留最近 1 天的有段会话（防误清刚结束的思考总结）。 */
const DEFAULT_CLEAR_GRACE_MS = 24 * 60 * 60 * 1000

export interface PersistHandle {
  /** 立即写盘（幂等；同步）。 */
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

  /** 同步原子写：tmp + rename（对齐 dsh-pet 的 savePetPersist）。 */
  const writeNow = () => {
    try {
      if (getOptions().persistEnabled === false) return // 关闭持久化：不写盘
      const dir = join(homedir(), '.dsh')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload = { version: 1, sessions: store.exportAll() }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
      // eslint-disable-next-line no-console
      console.log(`[dsh-think-summary] persist OK: ${payload.sessions.length} sessions -> ${file}`)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[dsh-think-summary] persist FAIL:', error instanceof Error ? error.message : String(error))
    }
  }

  // 启动加载：仅当持久化开启（默认开）。
  if (getOptions().persistEnabled !== false) {
    store.loadAll(readSaved())
    // eslint-disable-next-line no-console
    console.log(`[dsh-think-summary] persist loaded, store size=${store.size}`)
  } else {
    // eslint-disable-next-line no-console
    console.log('[dsh-think-summary] persist disabled by config')
  }

  // 状态变更 → **同步立即写**（不防抖）：begin/end/push/清理每次都落盘。
  // dsh 强杀/异常退出也不丢最后一条（写已完成才返回）。
  const offChange = store.onChange(writeNow)

  // 自动清理：定时检查"已归档"会话（非活跃 + 空闲超配置天数）
  const timer = ctx.get('timer') as { interval?: (fn: () => void, ms: number) => unknown } | undefined
  const autoClean = () => {
    const opts = getOptions()
    if (opts.autoCleanArchived !== true) return
    const days = typeof opts.autoCleanArchivedDays === 'number' && opts.autoCleanArchivedDays > 0
      ? opts.autoCleanArchivedDays
      : 30
    const removed = store.clearArchived(days * DAY_MS)
    if (removed > 0) writeNow() // 清理后落盘
  }
  const offInterval = timer?.interval?.(autoClean, CLEAN_INTERVAL_MS)

  // 生命周期清理：卸载时同步写盘并释放监听/定时器
  const dispose = () => {
    offChange?.()
    if (typeof offInterval === 'function') offInterval()
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
          let graceMs = DEFAULT_CLEAR_GRACE_MS
          const body = await readJsonBody<{ graceMs?: number }>(req)
          if (body && typeof body.graceMs === 'number' && body.graceMs >= 0) graceMs = body.graceMs
          const removed = store.clearArchived(graceMs)
          if (removed > 0) writeNow()
          writeJson(res, 200, { ok: true, removed, persisted: getOptions().persistEnabled !== false })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })

  return {
    flush: writeNow,
    clearArchived: (graceMs = DEFAULT_CLEAR_GRACE_MS) => {
      const n = store.clearArchived(graceMs)
      if (n > 0) writeNow()
      return n
    },
  }
}
