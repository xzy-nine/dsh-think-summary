/**
 * 模型池的**跨进程统计**：每个模型累计成功/失败次数 + 是否"从没成功过"。
 *
 * 用途：设置页的模型气泡按成功率显示状态色（绿 ≥50% / 黄 <50% 但仍可用 / 红 一次没成功），
 * 而"一次没成功过"这种判断必须跨进程累计——单次 dsh 运行内的样本太少，
 * 重启后就被清零的话永远显示不出红/绿。
 *
 * 存储：`~/.dsh/dsh-think-summary-pool.json`（与思考总结分开，互不干扰），
 * 原子写（tmp + rename），损坏/不可读时静默退回空统计（不阻断启动）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一个模型的累计统计。 */
export interface ModelStat {
  /** 成功次数（产出过可用摘要）。 */
  ok: number
  /** 失败次数（含超时/限流/格式不合规）。 */
  fail: number
}

/** 统计表：`provider/model` → 累计计数。 */
export type PoolStatsMap = Record<string, ModelStat>

/** 统计文件名（与 dsh-think-summary.json 分开，避免互相拖累体积/损坏风险）。 */
const FILE_NAME = 'dsh-think-summary-pool.json'

/**
 * 模型状态色档位（设置页气泡用）。
 *  - `green`：成功率 ≥50%（好用）
 *  - `yellow`：<50% 但成功过（可用，别指望）
 *  - `red`：一次都没成功过（不可用）
 *  - `unknown`：样本不足（<5 次），不显示颜色
 */
export type ModelHealth = 'green' | 'yellow' | 'red' | 'unknown'

/** 显示颜色所需的最少尝试次数（用户要求"至少 5 次后才显示颜色"）。 */
export const MIN_ATTEMPTS_FOR_COLOR = 5

/**
 * 由累计统计判定状态色。
 *
 * 规则（用户指定）：
 *  - 成功率 ≥50% → 绿；
 *  - <50% 但成功过 → 黄；
 *  - 一次没成功过 → 红（只要尝试数够）；
 *  - 总尝试 <5 次 → 不显示（`unknown`），避免刚加进来一两次失败就标红。
 * @param stat - 该模型的累计统计（可能未定义）。
 * @returns 状态色档位。
 */
export function healthOf(stat: ModelStat | undefined | null): ModelHealth {
  if (stat === undefined || stat === null) return 'unknown'
  const ok = typeof stat.ok === 'number' && Number.isFinite(stat.ok) && stat.ok > 0 ? Math.floor(stat.ok) : 0
  const fail = typeof stat.fail === 'number' && Number.isFinite(stat.fail) && stat.fail > 0 ? Math.floor(stat.fail) : 0
  const total = ok + fail
  if (total < MIN_ATTEMPTS_FOR_COLOR) return 'unknown'
  if (ok === 0) return 'red'
  return ok / total >= 0.5 ? 'green' : 'yellow'
}

/** 累计统计的持久化与查询（内存为准，变更即落盘）。 */
export class PoolStats {
  private map: PoolStatsMap = {}
  private readonly file: string
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param dir - 存储目录（默认 `~/.dsh`）。
   */
  constructor(dir?: string) {
    this.file = join(dir ?? join(homedir(), '.dsh'), FILE_NAME)
    this.load()
  }

  /** 读盘（损坏/缺失 → 空统计，不抛）。 */
  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const json = JSON.parse(readFileSync(this.file, 'utf8')) as { stats?: unknown }
      if (json === null || typeof json !== 'object' || json.stats === null || typeof json.stats !== 'object') return
      const out: PoolStatsMap = {}
      for (const [key, value] of Object.entries(json.stats as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') continue
        const v = value as { ok?: unknown; fail?: unknown }
        const ok = typeof v.ok === 'number' && Number.isFinite(v.ok) && v.ok > 0 ? Math.floor(v.ok) : 0
        const fail = typeof v.fail === 'number' && Number.isFinite(v.fail) && v.fail > 0 ? Math.floor(v.fail) : 0
        if (ok === 0 && fail === 0) continue
        out[key] = { ok, fail }
      }
      this.map = out
    } catch {
      /* 损坏/不可读：空统计继续（不阻断启动） */
    }
  }

  /**
   * 记一次成功。
   * @param key - `provider/model`。
   */
  recordOk(key: string): void {
    const cur = this.map[key] ?? { ok: 0, fail: 0 }
    this.map[key] = { ok: cur.ok + 1, fail: cur.fail }
    this.scheduleFlush()
  }

  /**
   * 记一次失败。
   * @param key - `provider/model`。
   */
  recordFail(key: string): void {
    const cur = this.map[key] ?? { ok: 0, fail: 0 }
    this.map[key] = { ok: cur.ok, fail: cur.fail + 1 }
    this.scheduleFlush()
  }

  /** 某模型的统计（副本；未记录时 undefined）。 */
  get(key: string): ModelStat | undefined {
    const hit = this.map[key]
    return hit === undefined ? undefined : { ok: hit.ok, fail: hit.fail }
  }

  /** 全量统计（副本，供 RPC 发给设置页）。 */
  all(): PoolStatsMap {
    const out: PoolStatsMap = {}
    for (const [key, value] of Object.entries(this.map)) out[key] = { ok: value.ok, fail: value.fail }
    return out
  }

  /** 立即落盘（进程退出前/测试用）。 */
  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.dirty) return
    try {
      const dir = join(this.file, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, stats: this.map }, null, 2), 'utf8')
      renameSync(tmp, this.file) // 原子替换：不会留半截文件
      this.dirty = false
    } catch {
      /* 写盘失败：内存统计仍然可用，只影响跨进程累计 */
    }
  }

  /**
   * 合并写：成功/失败可能连续发生（一个思考几十段），
   * 逐次同步写盘会拖慢精炼，所以合并到一次微任务后的写入。
   */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, 1000)
    // 不阻止进程退出（dsh 被强杀时最多丢 1s 内的计数）
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null && 'unref' in this.flushTimer) {
      (this.flushTimer as { unref?: () => void }).unref?.()
    }
  }
}
