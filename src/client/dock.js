/**
 * 输入框上方实时面板（conversation.input.dock 槽位）：
 * 样式配合输入框（宽度对齐官方 todo/queue dock）；可折叠、多行；
 * 只实时显示**当前这次思考**的每段摘要（思考中实时滚动，结束后短暂保留；
 * 新思考积累期保留上次思考摘要作为参照，首个新段出现即切换）。
 *
 * 视图过滤：只在"对话"视图显示（轨迹/思考总结等视图隐藏）。
 * 会话 store 的 view 状态在 slot 组件侧不可订阅，故检测 tablist 的
 * aria-selected（chat 视图 tab label = '对话'/'chat'）。
 */

/** 当前激活会话视图是否为"对话"。无 tablist（单视图/hero）视为对话。 */
function isChatTabActive() {
  if (typeof document === 'undefined') return true
  const tab = document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]')
  if (!tab) return true
  const s = (tab.textContent || '').trim()
  return s === '对话' || s.toLowerCase() === 'chat'
}

function makeInputDock() {
  return function ThinkInputDock(props) {
    const sessionId = props && props.sessionId
    const { state, enabled, paused } = useThinkState(sessionId)
    const [open, setOpen] = React.useState(true)
    const [prevOpen, setPrevOpen] = React.useState(false)
    const [chatView, setChatView] = React.useState(true)
    const [pauseBusy, setPauseBusy] = React.useState(false)

    // 视图过滤：只在"对话"视图显示（轨迹/思考总结等视图隐藏）。
    // 会话 store 的 view 状态在 slot 组件侧不可订阅，故定时检测 tablist 的
    // aria-selected（chat 视图 tab label = '对话'/'chat'）。
    React.useEffect(() => {
      let alive = true
      const check = () => { if (alive) setChatView(isChatTabActive()) }
      check()
      const timer = setInterval(check, 1500)
      return () => { alive = false; clearInterval(timer) }
    }, [])

    if (!enabled) return null // 插件总开关关闭：不显示实时思考面板
    if (!chatView) return null // 非"对话"视图：隐藏实时思考面板

    // 暂停/继续（全局，非设置项）：暂停后不再产出新总结，旧内容照常显示
    const togglePause = async () => {
      if (pauseBusy) return
      setPauseBusy(true)
      try {
        const res = await fetch(PAUSE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: !paused }),
        })
        // 状态由轮询刷新（1.5s 内同步）；失败则下次轮询回弹
        void res.json().catch(() => undefined)
      } catch {
        /* 失败忽略：轮询会恢复显示 */
      } finally {
        setPauseBusy(false)
      }
    }

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
            React.createElement('span', null, segHeadLabel(s, prefix)),
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
            chevronRightEl('ts-dock-prev-chevron'),
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
      'div', { className: 'ts-dock', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'div', { className: 'ts-dock-panel' },
        React.createElement(
          'div', { className: 'ts-dock-head' },
          // 折叠开关独立为小箭头按钮：点击箭头收起/展开，标题栏其他区域不再响应
          React.createElement(
            'button',
            {
              type: 'button', className: 'ts-dock-toggle', 'aria-expanded': open ? 'true' : 'false',
              title: open ? '收起' : '展开', onClick: () => setOpen(!open),
            },
            chevronEl('ts-dock-chevron'),
          ),
          React.createElement('span', { className: 'ts-dock-title' }, '思考总结'),
          React.createElement(
            'span', { className: 'ts-dock-progress' },
            think === null
              ? '等待思考…'
              : paused
                ? '已暂停 · 不再更新'
                : active
                  ? '思考中 · ' + fmtTok(think.tokens) + ' tok · ' + think.segments.length + ' 段'
                  : '思考结束 · ' + fmtTok(think.tokens) + ' tok · ' + think.segments.length + ' 段',
          ),
          paused ? React.createElement('span', { className: 'ts-dock-paused' }, '暂停') : null,
          active && !paused ? React.createElement('span', { className: 'ts-dock-dot' }) : null,
          refinedCount > 0 ? React.createElement('span', { className: 'ts-seg-refined' }, refinedCount + ' 段已精炼') : null,
          React.createElement(
            'button',
            {
              type: 'button', className: 'ts-dock-pause' + (paused ? ' on' : ''),
              disabled: pauseBusy, title: paused ? '继续思考总结' : '暂停思考总结（旧内容保留）',
              onClick: () => void togglePause(),
            },
            paused ? '继续' : '暂停',
          ),
        ),
        open ? React.createElement('div', { className: 'ts-dock-body' }, body) : null,
      ),
    )
  }
}
