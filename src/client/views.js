/**
 * "思考总结"视图（conversation.view 槽位条目，id 'think-summary'）：
 * 会话头部出现"思考总结"选项卡，显示当前会话**所有被记录**的思考总结
 * （实时 + 兜底的全部 think，按时间倒序），每个 think 一个可折叠卡片：
 * 段摘要 + 原始/精炼双 token + 状态标签。代码块/表格（ignore 模式）不显示。
 */

function makeThinkSummaryView() {
  return function ThinkSummaryView(props) {
    const sessionId = props && props.sessionId
    const [state, setState] = React.useState(null)
    const [openMap, setOpenMap] = React.useState({})

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

    const thinks = (state && state.thinks) || []
    const toggle = (id) => setOpenMap((m) => ({ ...m, [id]: !m[id] }))
    const open = (id) => (openMap[id] === undefined ? true : openMap[id])

    const thinkCards = [...thinks].reverse().map((t) => {
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
      const refinedCount = segs.length > 0 ? t.segments.filter((x) => x.refined).length : 0
      const expanded = open(t.id)
      return React.createElement(
        'div', { key: t.id, className: 'ts-view-card', 'data-open': expanded ? 'true' : 'false' },
        React.createElement(
          'button', { type: 'button', className: 'ts-view-head', onClick: () => toggle(t.id), 'aria-expanded': expanded ? 'true' : 'false' },
          React.createElement('span', { className: 'ts-view-chevron' }, '▾'),
          React.createElement('span', { className: 'ts-view-title' }, '思考 ' + t.id + (t.active ? ' · 进行中' : '')),
          React.createElement(
            'span', { className: 'ts-view-meta' },
            fmtTok(t.tokens) + ' tok · ' + (t.segments ? t.segments.length : 0) + ' 段' +
            (t.turn !== undefined ? ' · turn ' + t.turn : ''),
          ),
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined', style: { fontSize: 11 } }, refinedCount + ' 段已精炼') : null,
        ),
        expanded ? React.createElement('div', { className: 'ts-view-body' }, ...(segs.length > 0 ? segs : [React.createElement('div', { className: 'ts-dock-placeholder' }, '暂无分段（未达长思考阈值）')])) : null,
      )
    })

    return React.createElement(
      'div', { className: 'ts-view' },
      React.createElement(
        'div', { className: 'ts-view-header' },
        React.createElement('span', { className: 'ts-view-title-lg' }, '思考总结'),
        React.createElement('span', { className: 'ts-view-sub' }, '当前会话 · ' + thinks.length + ' 次思考' + (state && state.thinkingTokens ? ' · 累计 ' + fmtTok(state.thinkingTokens) + ' tok' : '')),
      ),
      thinks.length === 0
        ? React.createElement('div', { className: 'ts-view-empty' }, '暂无思考总结。触发长思考（超过阈值）后，这里会列出每段摘要。')
        : React.createElement('div', { className: 'ts-view-list' }, ...thinkCards),
    )
  }
}
