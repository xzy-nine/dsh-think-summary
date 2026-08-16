/**
 * 状态存储（v2）：会话级 + "每次思考"分组。
 * 说明：流上无法获得 turn（探测确认 GenerateOptions 无 turn 字段），
 * 实时路径以"每次 llm/stream 调用"为一个 think（id: s<序号>），
 * 兜底路径以 turn 为一个 think（id: t<turn>）；客户端按 think 分组折叠展示。
 */

export interface SegmentSummary {
  index: number
  summary: string
  tokens: number
  refined: boolean
  /** 'code'/'table' = 结构化摘要已足够，未调小模型精炼（省 token）。 */
  skipReason?: 'code' | 'table'
  /** 'self' = 主模型自产小结（selfSummary 模式捕获，直接展示，不经启发式/精炼）。 */
  kind?: 'self'
  /** 未精炼原因（小段/精炼失败/超时等；UI 状态标签显示）。 */
  unrefinedReason?: string
  /** 精炼实际消耗（估算）：输入 = 裁剪后喂入的 token，输出 = 摘要 token。 */
  refineTokens?: { input?: number; output?: number }
  ts: number
}

export interface ThinkGroup {
  /** think 唯一 id：实时 s<序号> / 兜底 t<turn>。 */
  id: string
  active: boolean
  /** 该次思考累计 token。 */
  tokens: number
  startedAt: number
  segments: SegmentSummary[]
  /** 会话 turn/step 标记（assistant/message 事件打标，供聊天流内 turnTail 匹配）。 */
  turn?: number
  step?: number
}

export interface ThinkState {
  sessionId: string
  /** 是否有活跃思考。 */
  active: boolean
  /** 当前思考是否已判定长思考。 */
  inSplice: boolean
  /** 当前思考的 token 数（进度头用）。 */
  thinkingTokens: number
  updatedAt: number
  thinks: ThinkGroup[]
  /** 内部去重集合；view() 时剥离。 */
  hashes: Set<string>
  /** think 序号（s<序号> 分配）。 */
  nextThinkId: number
}

const TTL_MS = 10 * 60 * 1000

export class ThinkStateStore {
  private map = new Map<string, ThinkState>()
  /** 最近活跃会话（侧边栏面板缺省 sessionId 时使用）。 */
  private lastActiveSessionId: string | undefined

  get(sessionId: string): ThinkState | undefined {
    return this.map.get(sessionId)
  }

  private create(sessionId: string): ThinkState {
    const s: ThinkState = {
      sessionId,
      active: false,
      inSplice: false,
      thinkingTokens: 0,
      updatedAt: Date.now(),
      thinks: [],
      hashes: new Set(),
      nextThinkId: 1,
    }
    this.map.set(sessionId, s)
    return s
  }

  /** 实时路径：开始一次新思考（每次 llm/stream 调用 = 一个新 think）。 */
  beginThink(sessionId: string): { state: ThinkState; think: ThinkGroup } {
    let s = this.map.get(sessionId)
    if (!s) s = this.create(sessionId)
    const think: ThinkGroup = {
      id: `s${s.nextThinkId++}`,
      active: true,
      tokens: 0,
      startedAt: Date.now(),
      segments: [],
    }
    s.thinks.push(think)
    s.active = true
    s.inSplice = false
    s.thinkingTokens = 0
    s.updatedAt = Date.now()
    this.lastActiveSessionId = sessionId
    return { state: s, think }
  }

  /** 兜底路径：取或建一个按 key 键控的 think（保持 active=false）。 */
  ensureThink(sessionId: string, thinkId: string): { state: ThinkState; think: ThinkGroup } {
    let s = this.map.get(sessionId)
    if (!s) s = this.create(sessionId)
    let think = s.thinks.find((t) => t.id === thinkId)
    if (!think) {
      think = { id: thinkId, active: false, tokens: 0, startedAt: Date.now(), segments: [] }
      s.thinks.push(think)
    }
    return { state: s, think }
  }

  /** 流结束：结束指定 think 并刷新会话活跃态。 */
  endThink(sessionId: string, thinkId: string): void {
    const s = this.get(sessionId)
    if (!s) return
    const think = s.thinks.find((t) => t.id === thinkId)
    if (think) think.active = false
    s.active = s.thinks.some((t) => t.active)
    s.updatedAt = Date.now()
  }

  /** 推入一个分段到指定 think。 */
  pushSegment(state: ThinkState, thinkId: string, segment: SegmentSummary): void {
    const think = state.thinks.find((t) => t.id === thinkId)
    if (!think) return
    think.segments.push(segment)
    state.updatedAt = Date.now()
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

  /** 供 Client 轮询的纯 JSON 视图（剥离内部 hashes/nextThinkId）。 */
  view(sessionId: string): Omit<ThinkState, 'hashes' | 'nextThinkId'> | undefined {
    const s = this.get(sessionId)
    if (!s) return undefined
    return {
      sessionId: s.sessionId,
      active: s.active,
      inSplice: s.inSplice,
      thinkingTokens: s.thinkingTokens,
      updatedAt: s.updatedAt,
      thinks: s.thinks.map((t) => ({ ...t, segments: t.segments.slice() })),
    }
  }

  get lastActive(): string | undefined {
    return this.lastActiveSessionId
  }
}
