/**
 * "思考总结"视图（conversation.view 槽位条目，id 'think-summary'）：
 * 会话头部出现"思考总结"选项卡，显示当前会话**所有有输出**的思考总结
 * （实时 + 兜底，无段落的 think 不显示），**按时间正序、最新的在底部**。
 * 自动滚动对齐聊天流式输出的官方逻辑（ui-conversation）：
 * scroll 事件实时判定"是否在底部"（距底 ≤25px），数据更新时**仅在底部才
 * 自动滚到底**；用户向上滚动即锁定，滚回底部自动恢复跟随。
 * 每个 think 一个可折叠卡片：段摘要 + 原始/精炼双 token + 状态标签。
 * 代码块/表格（ignore 模式）不显示。
 */

/** 找列表所在的滚动容器：优先官方会话滚动容器（data-conversation-scroll），兜底向上找可滚动祖先。 */
function findScroller(el) {
  if (!el) return null
  const host = el.closest ? el.closest('[data-conversation-scroll]') : null
  if (host instanceof HTMLElement) return host
  let p = el.parentElement
  let depth = 0
  while (p && depth < 8) {
    if (p.scrollHeight > p.clientHeight + 1) return p
    p = p.parentElement
    depth++
  }
  return null
}

function makeThinkSummaryView() {
  return function ThinkSummaryView(props) {
    const sessionId = props && props.sessionId
    const [state, setState] = React.useState(null)
    const [openMap, setOpenMap] = React.useState({})
    const listRef = React.useRef(null)
    // 是否停在底部（用户滚动时由 scroll 事件实时更新；仅在底部时自动跟随）
    const atBottomRef = React.useRef(true)

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

    // 对齐官方流式滚动：scroll 事件更新 atBottom（距底 ≤25px 视为在底部）；
    // 数据更新（state 变化）时仅在 atBottom 才滚到底——用户上滚即锁定，滚回底部自动恢复
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
      update()
      if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight // 初始/跟随滚底
      return () => scroller.removeEventListener('scroll', update)
    }, [state])

    const thinks = (state && state.thinks) || []
    // 只显示有输出的思考；正序（最新的在底部）
    const visible = thinks.filter((t) => t.segments && t.segments.length > 0)
    const toggle = (id) => setOpenMap((m) => ({ ...m, [id]: !m[id] }))
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
          React.createElement('span', { className: 'ts-view-chevron' }, '▾'),
          React.createElement('span', { className: 'ts-view-title' }, '思考 ' + t.id + (t.active ? ' · 进行中' : '')),
          React.createElement(
            'span', { className: 'ts-view-meta' },
            fmtTok(t.tokens) + ' tok · ' + t.segments.length + ' 段' +
            (t.turn !== undefined ? ' · turn ' + t.turn : ''),
          ),
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined', style: { fontSize: 11 } }, refinedCount + ' 段已精炼') : null,
        ),
        expanded ? React.createElement('div', { className: 'ts-view-body' }, ...segs) : null,
      )
    })

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
