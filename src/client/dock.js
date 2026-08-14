/**
 * 输入框上方实时面板（conversation.input.dock 槽位）：
 * 样式配合输入框（input-major 背景 + 宽度对齐 composer 卡片）；可折叠、多行；
 * 只实时显示**当前这次思考**的每段摘要（思考中实时滚动，结束后短暂保留；
 * 新思考积累期保留上次思考摘要作为参照，首个新段出现即切换）。
 */
function makeInputDock() {
  return function ThinkInputDock(props) {
    const sessionId = props && props.sessionId
    const [state, setState] = React.useState(null)
    const [open, setOpen] = React.useState(true)
    const [prevOpen, setPrevOpen] = React.useState(false)

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
          /* 轮询失败不影响聊天 */
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

    // 只取"当前这次思考"：活跃的 think 优先；无活跃则最近一次（常驻显示最近一次）
    let think = null
    let prev = null
    if (state && state.thinks && state.thinks.length > 0) {
      think = state.thinks.find((t) => t.active) || state.thinks[state.thinks.length - 1]
      const idx = state.thinks.indexOf(think)
      if (idx > 0) prev = state.thinks[idx - 1]
    }
    // 新思考积累期（活跃且还没有段）：保留上次思考摘要作为参照，首个新段出现即切换
    const accumulating = think !== null && think.active && think.segments.length === 0

    const active = think ? think.active : false
    const refinedCount = think ? think.segments.filter((s) => s.refined).length : 0

    const segEls = (t, prefix) =>
      (t ? t.segments : []).map((s) =>
        React.createElement(
          'div', { key: t.id + ':' + s.index, className: 'ts-dock-seg' },
          React.createElement(
            'div', { className: 'ts-dock-seg-head' },
            React.createElement('span', null, prefix + '第' + (s.index + 1) + '段 · 原始 ' + fmtTok(s.tokens) + ' tok' + refineTokStr(s)),
            segStatusEl(s),
          ),
          React.createElement('div', { className: 'ts-dock-seg-text' }, s.summary),
        ),
      )

    // 主体内容
    let body
    if (think === null) {
      body = React.createElement('div', { className: 'ts-dock-placeholder' }, '等待模型思考，超阈值后开始分段总结…')
    } else if (accumulating) {
      // 新思考积累中：保留上次思考摘要（标注），当前思考占位行
      const prevBlock = prev && prev.segments.length > 0
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement('div', { className: 'ts-dock-placeholder', style: { paddingBottom: 2 } }, '上次思考总结（保留中，新段出现后切换）'),
            ...segEls(prev, '上次 · '),
          )
        : null
      body = React.createElement(
        React.Fragment,
        null,
        prevBlock,
        React.createElement('div', { className: 'ts-dock-placeholder' }, '当前思考积累中 · ' + fmtTok(think.tokens) + ' tok…'),
      )
    } else {
      // 当前思考已有段：显示当前段；上次思考收成可展开一行
      const prevToggle = prev && prev.segments.length > 0
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'ts-dock-prev',
              onClick: () => setPrevOpen(!prevOpen),
              'aria-expanded': prevOpen ? 'true' : 'false',
            },
            React.createElement('span', { className: 'ts-dock-prev-chevron' }, '▸'),
            React.createElement('span', null, '上次思考 · ' + prev.segments.length + ' 段'),
          )
        : null
      body = React.createElement(
        React.Fragment,
        null,
        think.segments.length > 0 ? segEls(think, '') : React.createElement('div', { className: 'ts-dock-placeholder' }, '正在积累思考…'),
        prevToggle,
        prevOpen && prev ? React.createElement('div', { className: 'ts-dock-prev-body' }, ...segEls(prev, '上次 · ')) : null,
      )
    }

    return React.createElement(
      'div', { className: 'ts-dock' },
      React.createElement(
        'div', { className: 'ts-dock-panel', 'data-open': open ? 'true' : 'false' },
        React.createElement(
          'button',
          { type: 'button', className: 'ts-dock-head', onClick: () => setOpen(!open) },
          React.createElement('span', { className: 'ts-dock-chevron' }, '▾'),
          React.createElement('span', { className: 'ts-dock-title' }, '思考总结'),
          React.createElement(
            'span', { className: 'ts-dock-progress' },
            think === null
              ? '等待思考…'
              : active
                ? '思考中 · ' + fmtTok(think.tokens) + ' tok · ' + think.segments.length + ' 段'
                : '思考结束 · ' + fmtTok(think.tokens) + ' tok · ' + think.segments.length + ' 段',
          ),
          active ? React.createElement('span', { className: 'ts-dock-dot' }) : null,
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined', style: { fontSize: 11 } }, refinedCount + ' 段已精炼') : null,
        ),
        open ? React.createElement('div', { className: 'ts-dock-body' }, body) : null,
      ),
    )
  }
}
