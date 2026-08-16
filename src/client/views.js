/**
 * "思考总结"视图（conversation.view 槽位条目，id 'think-summary'）：
 * 会话头部出现"思考总结"选项卡，显示当前会话**所有有输出**的思考总结
 * （实时 + 兜底，无段落的 think 不显示），**按时间正序、最新的在底部**。
 * 自动滚动：首次/挂载时滚到底部；scroll 事件实时判定"是否在底部"
 * （距底 ≤25px），数据更新时仅在底部才继续跟随——用户上滚即锁定，
 * 滚回底部自动恢复。折叠状态持久化（localStorage），切选项卡不丢失。
 * 每个 think 一个可折叠卡片：段摘要 + 原始/精炼双 token + 状态标签。
 * 代码块/表格（ignore 模式）不显示。
 */

/** 折叠状态持久化键。 */
const OPEN_MAP_KEY = 'dsh.thinkSummary.openMap.v1'

/** 找列表所在的**实际可滚动**祖先（不依赖 data-conversation-scroll 标记，
 * 避免误命中非滚动容器导致 scrollTop 设置无效）。 */
function findScroller(el) {
  if (!el) return null
  let p = el.parentElement
  let depth = 0
  while (p && depth < 10) {
    if (p.scrollHeight > p.clientHeight + 1) return p
    p = p.parentElement
    depth++
  }
  return null
}

/** 读/写折叠状态（localStorage 持久化，切选项卡不丢）。 */
function readOpenMap() {
  try {
    const raw = localStorage.getItem(OPEN_MAP_KEY)
    if (raw) {
      const m = JSON.parse(raw)
      if (m && typeof m === 'object') return m
    }
  } catch {
    /* 不可用则用空 */
  }
  return {}
}

function writeOpenMap(m) {
  try {
    localStorage.setItem(OPEN_MAP_KEY, JSON.stringify(m))
  } catch {
    /* 忽略 */
  }
}

function makeThinkSummaryView() {
  return function ThinkSummaryView(props) {
    const sessionId = props && props.sessionId
    const [state, setState] = React.useState(null)
    const [enabled, setEnabled] = React.useState(true)
    const [openMap, setOpenMap] = React.useState(readOpenMap)
    const listRef = React.useRef(null)
    // 是否停在底部（用户滚动时由 scroll 事件实时更新；仅在底部时自动跟随）
    const atBottomRef = React.useRef(true)
    // 首次渲染（列表出现）强制滚到底部，此后由 scroll 事件接管
    const firstRunRef = React.useRef(true)

    React.useEffect(() => {
      if (!sessionId) return undefined
      let alive = true
      let timer = null
      const poll = async () => {
        try {
          const res = await fetch(STATE_ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
          if (!res.ok) return
          const json = await res.json()
          if (!alive) return
          setEnabled(!json || json.enabled !== false)
          setState((json && json.state) || null)
        } catch {
          /* 轮询失败不影响 */
        } finally {
          if (!alive) return
          timer = setTimeout(poll, 1500)
        }
      }
      void poll()
      return () => {
        alive = false
        if (timer !== null) clearTimeout(timer)
      }
    }, [sessionId])

    // 滚动：scroll 事件更新 atBottom；数据更新时仅在底部才滚底；
    // 首次挂载强制滚底（否则初始 update() 会把 atBottom 算成 false，
    // 内容停在顶部——用户看到的"总是滚到顶部"）
    React.useEffect(() => {
      const el = listRef.current
      if (!el) return undefined
      const scroller = findScroller(el)
      if (!scroller) return undefined
      const update = () => {
        const floor = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        atBottomRef.current = floor - scroller.scrollTop <= 25
      }
      scroller.addEventListener('scroll', update, { passive: true })
      if (firstRunRef.current) {
        firstRunRef.current = false
        atBottomRef.current = true
        scroller.scrollTop = scroller.scrollHeight // 初始滚到底部
      } else {
        update()
        if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight // 跟随滚底
      }
      return () => scroller.removeEventListener('scroll', update)
    }, [state])

    const thinks = (state && state.thinks) || []
    // 只显示有输出的思考；正序（最新的在底部）
    const visible = thinks.filter((t) => t.segments && t.segments.length > 0)
    const toggle = (id) => setOpenMap((m) => {
      const next = { ...m, [id]: !m[id] }
      writeOpenMap(next) // 持久化折叠状态：切选项卡/重挂不丢失
      return next
    })
    const open = (id) => (openMap[id] === undefined ? true : openMap[id])

    const thinkCards = visible.map((t) => {
      const segs = (t.segments || []).map((s) =>
        React.createElement(
          'div', { key: t.id + ':' + s.index, className: 'ts-view-seg' },
          React.createElement(
            'div', { className: 'ts-view-seg-head' },
            React.createElement('span', null, segHeadLabel(s, '')),
            segStatusEl(s),
          ),
          React.createElement('div', { className: 'ts-view-seg-text' }, s.summary),
        ),
      )
      const refinedCount = t.segments.filter((x) => x.refined).length
      const expanded = open(t.id)
      return React.createElement(
        'div', { key: t.id, className: 'ts-view-card', 'data-open': expanded ? 'true' : 'false' },
        React.createElement(
          'button', { type: 'button', className: 'ts-view-head', onClick: () => toggle(t.id), 'aria-expanded': expanded ? 'true' : 'false' },
          chevronEl('ts-view-chevron'),
          React.createElement('span', { className: 'ts-view-title' }, '思考 ' + t.id + (t.active ? ' · 进行中' : '')),
          React.createElement(
            'span', { className: 'ts-view-meta' },
            fmtTok(t.tokens) + ' tok · ' + t.segments.length + ' 段' +
            (t.turn !== undefined ? ' · turn ' + t.turn : ''),
          ),
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined' }, refinedCount + ' 段已精炼') : null,
        ),
        expanded ? React.createElement('div', { className: 'ts-view-body' }, ...segs) : null,
      )
    })

    if (!enabled) return null // 插件总开关关闭：视图不显示

    return React.createElement(
      'div', { className: 'ts-view' },
      React.createElement(
        'div', { className: 'ts-view-header' },
        React.createElement('span', { className: 'ts-view-title-lg' }, '思考总结'),
        React.createElement('span', { className: 'ts-view-sub' }, '当前会话 · ' + visible.length + ' 次思考' + (state && state.thinkingTokens ? ' · 累计 ' + fmtTok(state.thinkingTokens) + ' tok' : '')),
      ),
      visible.length === 0
        ? React.createElement('div', { className: 'ts-view-empty' }, '暂无思考总结。触发长思考（超过阈值）后，这里会列出每段摘要。')
        : React.createElement('div', { className: 'ts-view-list', ref: listRef }, ...thinkCards),
    )
  }
}
