/**
 * 聊天流内思考总结条（conversation.chat.turnTail 槽位）：
 * 在对应助手消息（一次思考 = 一个 step）输出下方渲染该 think 的分段摘要，
 * 可折叠、多行显示。匹配：sessionId + think.turn/step === 节点 turn/step。
 *
 * 槽位契约（Inspect 确认）：owner = { turn: TurnLocation, seq: number, openFile }；
 * select 的返回值作为组件的 `matched` prop（非覆盖 props.turn/seq）。
 */
function makeThinkTail() {
  return function ThinkTail(props) {
    const sessionId = props && props.sessionId
    const m = props && props.matched
    const turn = m && m.turn // TurnLocation（含 turn 号与 steps）
    const seq = m && m.seq
    const [think, setThink] = React.useState(null)
    const [open, setOpen] = React.useState(true)

    React.useEffect(() => {
      if (!sessionId || !turn) return undefined
      let alive = true
      let timer = null
      let tries = 0
      // 节点所在 step 号：steps[] 中 end.seq === 本节点 seq 的那一步
      let stepNo = undefined
      if (turn.steps && Array.isArray(turn.steps)) {
        const hit = turn.steps.find((s) => s && s.end && s.end.seq === seq) || turn.steps.find((s) => s && s.step !== undefined)
        stepNo = hit && hit.step
      }
      const load = async () => {
        try {
          const res = await fetch(STATE_ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
          if (!res.ok) return
          const json = await res.json()
          if (!alive) return
          const state = json && json.state
          if (!state) return
          const matched = (state.thinks || []).find(
            (t) => t.turn === turn.turn && (stepNo === undefined || t.step === stepNo) && t.segments && t.segments.length > 0,
          )
          if (matched) {
            setThink(matched)
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
    }, [sessionId, turn, seq])

    if (!think) return null

    const refinedCount = think.segments.filter((s) => s.refined).length
    const segEls = think.segments.map((s) =>
      React.createElement(
        'div', { key: s.index, className: 'ts-tail-seg' },
        React.createElement(
          'div', { className: 'ts-tail-seg-head' },
          React.createElement('span', null, '第' + (s.index + 1) + '段 · 原始 ' + fmtTok(s.tokens) + ' tok' + refineTokStr(s)),
          segStatusEl(s),
        ),
        React.createElement('div', { className: 'ts-tail-seg-text' }, s.summary),
      ),
    )

    return React.createElement(
      'div', { className: 'ts-tail', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'ts-tail-head',
          onClick: () => setOpen(!open),
        },
        React.createElement('span', { className: 'ts-tail-chevron' }, '▾'),
        React.createElement('span', { className: 'ts-tail-title' }, '思考总结'),
        React.createElement('span', { className: 'ts-tail-meta' }, think.segments.length + ' 段 · ' + fmtTok(think.tokens) + ' tok'),
        refinedCount > 0 ? React.createElement('span', { className: 'ts-tail-refined' }, refinedCount + ' 段已精炼') : null,
      ),
      open ? React.createElement('div', { className: 'ts-tail-body' }, ...segEls) : null,
    )
  }
}
