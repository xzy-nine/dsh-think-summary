/**
 * M2 状态存储：会话级内存态（sessionId 键控），只存标量/自有 JSON。
 * 说明：流上无法获得 turn（探测确认 GenerateOptions 无 turn 字段），
 * 故采用"会话级 + TTL 清理"替代设计稿的 sessionId+turn 键控（见 design.md §4.4 修正）。
 */

export interface SegmentSummary {
  index: number
  summary: string
  tokens: number
  refined: boolean
  ts: number
}

export interface ThinkState {
  sessionId: string
  active: boolean
  thinkingTokens: number
  inSplice: boolean
  segments: SegmentSummary[]
  updatedAt: number
  /** 内部去重集合；view() 时剥离，不对外。 */
  hashes: Set<string>
}

const TTL_MS = 10 * 60 * 1000

export class ThinkStateStore {
  private map = new Map<string, ThinkState>()

  get(sessionId: string): ThinkState | undefined {
    return this.map.get(sessionId)
  }

  /** 流开始：取或建（不重置——多步同会话连续流共享状态）。 */
  begin(sessionId: string): ThinkState {
    let s = this.map.get(sessionId)
    if (!s) {
      s = {
        sessionId,
        active: true,
        thinkingTokens: 0,
        inSplice: false,
        segments: [],
        updatedAt: Date.now(),
        hashes: new Set(),
      }
      this.map.set(sessionId, s)
    }
    s.active = true
    s.updatedAt = Date.now()
    return s
  }

  /** 兜底路径使用：取或建，但保持 active=false（非流上下文）。 */
  ensure(sessionId: string): ThinkState {
    let s = this.map.get(sessionId)
    if (!s) {
      s = {
        sessionId,
        active: false,
        thinkingTokens: 0,
        inSplice: false,
        segments: [],
        updatedAt: Date.now(),
        hashes: new Set(),
      }
      this.map.set(sessionId, s)
    }
    return s
  }

  /** 流结束（finish/error/abort）。 */
  end(sessionId: string): void {
    const s = this.get(sessionId)
    if (s) {
      s.active = false
      s.updatedAt = Date.now()
    }
  }

  /** 过期清理（空闲超过 TTL）；返回移除数。 */
  sweep(now = Date.now()): number {
    let removed = 0
    for (const [k, s] of this.map) {
      if (!s.active && now - s.updatedAt > TTL_MS) {
        this.map.delete(k)
        removed++
      }
    }
    return removed
  }

  /** 供 Client 轮询的纯 JSON 视图（剥离内部 hashes）。 */
  view(sessionId: string): Omit<ThinkState, 'hashes'> | undefined {
    const s = this.get(sessionId)
    if (!s) return undefined
    return {
      sessionId: s.sessionId,
      active: s.active,
      thinkingTokens: s.thinkingTokens,
      inSplice: s.inSplice,
      segments: s.segments.slice(),
      updatedAt: s.updatedAt,
    }
  }
}
