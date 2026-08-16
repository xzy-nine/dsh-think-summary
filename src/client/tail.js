/**
 * 聊天流内思考总结条（conversation.chat.turnTail 槽位）：
 * 该槽位是 **turn 级**（渲染在整个回复末尾，非每个 think 块下），
 * 因此显示该 turn **所有有段**的思考（按 step 分组，区分每次思考）：
 *  - 匹配：sessionId + think.turn === 节点 turn（取全部有段 think，按 step 排序）
 *  - 每个 think 一个分组：头部"思考 · step N · X 段"（单 think 时省略分组头）
 *  - 组内段摘要 + 原始/精炼双 token + 状态标签；可折叠
 *
 * 槽位契约（Inspect 确认）：owner = { turn: TurnLocation, seq, openFile }；
 * select 返回值作为组件 matched prop。
 */
function makeThinkTail() {
  return function ThinkTail(props) {
    const sessionId = props && props.sessionId
    const m = props && props.matched
    const turn = m && m.turn // TurnLocation（含 turn 号与 steps）
    const seq = m && m.seq
    const [thinks, setThinks] = React.useState([])
    // 默认折叠：总结条收起，点击展开查看各思考分组
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
      if (!sessionId || !turn) return undefined
      let alive = true
      let timer = null
      let tries = 0
      const load = async () => {
        try {
          const res = await fetch(STATE_ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
          if (!res.ok) return
          const json = await res.json()
          if (!alive) return
          const state = json && json.state
          if (!state) return
          // 该 turn 的所有有段 think（区分每次思考：多 step 思考各自成组）
          const matched = (state.thinks || [])
            .filter((t) => t.turn === turn.turn && t.segments && t.segments.length > 0)
            .sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
          if (matched.length > 0) {
            setThinks(matched)
            return // 找到即停（含精炼完成的标记）
          }
        } catch {
          /* 轮询失败不渲染 */
        }
        tries++
        if (tries < 8) timer = setTimeout(load, 1200)
      }
      void load()
      return () => {
        alive = false
        if (timer !== null) clearTimeout(timer)
      }
    }, [sessionId, turn])

    if (thinks.length === 0) return null

    const totalSegs = thinks.reduce((n, t) => n + t.segments.length, 0)
    const totalRefined = thinks.reduce((n, t) => n + t.segments.filter((s) => s.refined).length, 0)

    // 按 think 分组：多思考时每组标注 step；单思考保持紧凑
    const groups = thinks.map((think) => {
      const segEls = think.segments.map((s) =>
        React.createElement(
          'div', { key: think.id + ':' + s.index, className: 'ts-tail-seg' },
          React.createElement(
            'div', { className: 'ts-tail-seg-head' },
            React.createElement('span', null, segHeadLabel(s, '')),
            segStatusEl(s),
          ),
          React.createElement('div', { className: 'ts-tail-seg-text' }, s.summary),
        ),
      )
      return React.createElement(
        'div', { key: think.id, className: 'ts-tail-group' },
        thinks.length > 1
          ? React.createElement(
              'div', { className: 'ts-tail-group-head' },
              '思考 · step ' + (think.step ?? '?') + ' · ' + think.segments.length + ' 段 · ' + fmtTok(think.tokens) + ' tok',
            )
          : null,
        ...segEls,
      )
    })

    return React.createElement(
      'div', { className: 'ts-tail', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'ts-tail-head',
          onClick: () => setOpen(!open),
        },
        chevronEl('ts-tail-chevron'),
        React.createElement('span', { className: 'ts-tail-title' }, '思考总结'),
        React.createElement('span', { className: 'ts-tail-meta' }, totalSegs + ' 段 · ' + thinks.length + ' 次思考'),
        totalRefined > 0 ? React.createElement('span', { className: 'ts-tail-refined' }, totalRefined + ' 段已精炼') : null,
      ),
      open ? React.createElement('div', { className: 'ts-tail-body' }, ...groups) : null,
    )
  }
}
