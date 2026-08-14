/**
 * dsh-think-summary web client（纯 JS，由 scripts/build-client.mjs 打包为
 * ModuleLoader bundle）。不依赖 JSX/TS——React 来自 bundle 包裹层的
 * `require("react")`；侧边栏面板用纯 DOM 注入（shell 无外部可注册的
 * 侧边栏槽位，遵循 dsh-ssh / task-board 的 DOM 扩展先例）。
 *
 * 职责：
 *  1. settings.plugin.item 设置卡片（自建设置桥，默认折叠）
 *  2. 侧边栏"思考总结"入口 + 可折叠卡片：按每次思考分组，组内可折叠；
 *     思考一开始即显示（不等阈值），实时滚动分段摘要
 *
 * 失败策略：任何 DOM/网络异常只记录，绝不向上抛（web shell 会因插件 apply
 * 抛错而整个启动失败）。
 */
const NS = 'think-summary'
const STATE_ROUTE = '/api/think-summary/state'
const SETTINGS_PREFIX = '/api/think-summary/settings'
const KEEP_MS = 30000
const POLL_MS = 1500
const IDLE_POLL_MS = 5000

/** 主题变量（带降级）。 */
const T = {
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
  bg: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.07))',
  text: 'var(--dsw-alias-label-primary, inherit)',
  dim: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.85))',
  accent: 'var(--dsw-alias-button-info-fill, #4a9eff)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))',
  ok: 'var(--dsw-alias-success-fill, #34c759)',
  err: 'var(--dsw-alias-danger-fill, #ff5f57)',
  warn: '#ffd60a',
}

/** 侧边栏面板样式（注入一次 <style>）。 */
const PANEL_CSS = `
.ts-block{margin:2px 8px 4px}
.ts-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:6px;background:transparent;border:none;color:${T.text};font:inherit;font-size:13px;cursor:pointer;text-align:left}
.ts-entry:hover,.ts-entry[data-active="true"]{background:${T.hover}}
.ts-entry svg{flex:none;color:${T.dim}}
.ts-card{border:1px solid ${T.border};border-radius:6px;background:${T.bg};margin-top:2px;overflow:hidden}
.ts-card[hidden]{display:none}
.ts-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid ${T.border};font-size:12px;color:${T.text}}
.ts-dot{width:7px;height:7px;border-radius:50%;flex:none}
.ts-head-tok{color:${T.dim};font-variant-numeric:tabular-nums}
.ts-body{max-height:50vh;overflow:auto}
.ts-think{border-bottom:1px solid ${T.border}}
.ts-think:last-child{border-bottom:none}
.ts-think-head{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px;background:transparent;border:none;color:${T.text};font:inherit;font-size:12px;cursor:pointer;text-align:left}
.ts-think-head:hover{background:${T.hover}}
.ts-think-chevron{transition:transform .12s;color:${T.dim}}
.ts-think[data-open="true"] .ts-think-chevron{transform:rotate(180deg)}
.ts-think-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ts-think-meta{flex:none;color:${T.dim};font-size:10.5px;white-space:nowrap}
.ts-think-status{flex:none;font-size:10.5px;white-space:nowrap}
.ts-seg{display:flex;gap:8px;align-items:baseline;padding:3px 10px 3px 22px;font-size:12px}
.ts-seg-num{flex:none;color:${T.dim};font-size:10.5px;min-width:16px;text-align:right}
.ts-seg-sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${T.text}}
.ts-seg-meta{flex:none;color:${T.dim};font-size:10.5px;white-space:nowrap}
.ts-seg-refined{color:${T.accent}}
.ts-placeholder{padding:6px 10px;font-size:12px;color:${T.dim}}
`

/** 入口图标（16px 导航图标观感）。 */
const ENTRY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5c-3 0-5.5 2.2-5.5 5 0 1.5.7 2.8 1.8 3.7-.2 1.2-.9 2.3-1.8 3.1 2.1-.2 3.8-1 5-2 1.8.4 3.7-.1 5-1.6.9-1 .7-1.4.9-2.6.4-1.5 1.2-2.6 1.2-2.6s-2.5 0-4.5-1.6C9.2 2.2 8.7 1.5 8 1.5z"/></svg>'

/** 设置卡片字段定义（与 Host schema 对齐；分组渲染）。 */
const FIELD_GROUPS = [
  {
    caption: '检测与分段',
    fields: [
      { key: 'enabled', label: '启用', kind: 'bool', hint: '总开关，关闭后停止检测' },
      { key: 'thinkThresholdTokens', label: '长思考阈值', kind: 'num', unit: 'tok', hint: '思考超过该长度判定为长思考并开始分段' },
      { key: 'segmentMinTokens', label: '段最小窗口', kind: 'num', unit: 'tok', hint: '达到后可切（等待语义边界信号）' },
      { key: 'segmentMaxTokens', label: '段硬上限', kind: 'num', unit: 'tok', hint: '到点强制切，保证缓冲有界' },
    ],
  },
  {
    caption: '小模型精炼',
    fields: [
      { key: 'refineEnabled', label: '精炼', kind: 'bool', hint: '开启后所有分段都会用最小模型精炼摘要' },
      { key: 'refineOutputTokens', label: '精炼预算', kind: 'num', unit: 'tok', hint: 'API 完成预算（推理+答案）' },
      { key: 'refineModel', label: '精炼模型', kind: 'text', hint: "'auto' = 最小可用模型；可显式指定" },
    ],
  },
]

function numOrUndef(s) {
  if (s === null || s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function fmtTok(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–'
  if (n < 1000) return String(n)
  const k = (n / 1000).toFixed(1).replace(/\.0$/, '')
  return k + 'k'
}

/** 开关（视觉 switch，实际是带 aria 的 button）。 */
function makeToggle(on, onChange, disabled) {
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      disabled: !!disabled,
      onClick: () => onChange(!on),
      style: {
        width: 30, height: 17, borderRadius: 9, border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: on ? T.accent : T.hover, position: 'relative', flex: 'none',
        opacity: disabled ? 0.5 : 1, padding: 0, transition: 'background .12s',
      },
    },
    React.createElement('span', {
      style: {
        position: 'absolute', top: 2, left: on ? 15 : 2, width: 13, height: 13, borderRadius: '50%',
        background: '#fff', transition: 'left .12s', boxShadow: '0 1px 2px rgba(0,0,0,.3)',
      },
    }),
  )
}

function makeButton(label, kind, onClick, disabled) {
  const primary = kind === 'primary'
  return React.createElement(
    'button',
    {
      type: 'button',
      disabled: !!disabled,
      onClick,
      style: {
        padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: disabled ? 'default' : 'pointer',
        border: primary ? 'none' : '1px solid ' + T.border,
        background: primary ? T.accent : 'transparent',
        color: primary ? '#fff' : T.text,
        opacity: disabled ? 0.5 : 1,
      },
    },
    label,
  )
}

/**
 * 自建设置桥 scope（M4 部署修正）：官方设置桥只服务白名单命名空间，
 * web-ui 组桥接只认家族清单——独立第三方插件必须自带 loopback 设置桥。
 */
function createBridgeScope() {
  let snap = { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }
  const listeners = new Set()
  const publish = (next) => {
    snap = next
    for (const listener of listeners) listener()
  }
  const post = async (path, body) => {
    try {
      const response = await fetch(SETTINGS_PREFIX + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }
  const load = async () => {
    const json = await post('/describe', {})
    if (!json || !json.ok || !json.value) {
      publish({ ...snap, status: 'unavailable', writable: false })
      return
    }
    const view = (json.value.namespaces || []).find((n) => n.ns === NS)
    if (!view) {
      publish({ ...snap, status: 'unavailable', writable: json.value.writable === true })
      return
    }
    publish({
      status: 'ready',
      value: view.value,
      base: view.base,
      user: view.user,
      revision: view.revision,
      writable: view.writable === true,
    })
  }
  const mutate = async (ops) => {
    const json = await post('/mutate', { ops, expectedRevision: snap.revision })
    if (json && json.ok && json.value) {
      publish({
        status: 'ready',
        value: json.value.value,
        base: json.value.base,
        user: json.value.user,
        revision: json.value.revision,
        writable: json.value.writable === true,
      })
    } else {
      await load()
    }
  }
  void load()
  return {
    getSnapshot: () => snap,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => mutate([{ op: 'set', path: [field], value }]),
    unset: (field) => mutate([{ op: 'unset', path: [field] }]),
    load,
  }
}

/** 设置卡片：默认折叠，点头部展开；分组字段 + 开关/单位/按钮/状态。 */
function makeSettingsCard(scope) {
  return function SettingsCard() {
    const [snap, setSnap] = React.useState(null)
    const [draft, setDraft] = React.useState({})
    const [busy, setBusy] = React.useState(false)
    const [msg, setMsg] = React.useState('')
    const [msgKind, setMsgKind] = React.useState('')
    const [seed, setSeed] = React.useState(0)
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
      const sync = () => setSnap(scope.getSnapshot())
      sync()
      const un = scope.subscribe(sync)
      return () => { if (typeof un === 'function') un() }
    }, [])

    React.useEffect(() => {
      if (snap && snap.status === 'ready' && !busy) {
        const v = snap.value || {}
        const next = {}
        for (const group of FIELD_GROUPS) {
          for (const f of group.fields) {
            next[f.key] = f.kind === 'bool' ? (v[f.key] === undefined ? true : !!v[f.key]) : (v[f.key] === undefined ? '' : String(v[f.key]))
          }
        }
        setDraft(next)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap, busy, seed])

    if (!snap || snap.status === 'loading') return null

    const card = { border: '1px solid ' + T.border, borderRadius: 6, background: T.bg, overflow: 'hidden', color: T.text }
    const titleStyle = { fontSize: 14, fontWeight: 600, color: T.text }
    const descStyle = { fontSize: 12.5, color: T.dim, lineHeight: 1.4 }
    const chevron = (expanded) => ({
      flex: 'none', marginLeft: 10, fontSize: 13, color: T.dim,
      transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .12s',
    })
    const headerStyle = {
      width: '100%', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
      background: 'transparent', border: 'none', justifyContent: 'space-between',
      alignItems: 'center', padding: '12px 14px', display: 'flex', gap: 10,
    }

    if (snap.status === 'unavailable') {
      return React.createElement(
        'div', { style: card },
        React.createElement('div', { style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3 } },
          React.createElement('div', { style: titleStyle }, 'think-summary'),
          React.createElement('div', { style: descStyle }, '设置桥不可用：宿主未运行本插件的 Host 半面。'),
        ),
      )
    }

    const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }))

    const save = async () => {
      setBusy(true)
      setMsg('')
      setMsgKind('')
      try {
        for (const group of FIELD_GROUPS) {
          for (const f of group.fields) {
            if (f.kind === 'bool') {
              await scope.set(f.key, !!draft[f.key])
            } else if (f.kind === 'num') {
              const n = numOrUndef(draft[f.key])
              if (n === undefined) {
                setMsgKind('err')
                setMsg(f.label + ' 不是有效数字')
                return
              }
              await scope.set(f.key, n)
            } else {
              const t = (draft[f.key] || '').trim()
              if (t === '') await scope.unset(f.key)
              else await scope.set(f.key, t)
            }
          }
        }
        setMsgKind('ok')
        setMsg('已保存，即时生效')
        setSeed((s) => s + 1)
      } catch (e) {
        setMsgKind('err')
        setMsg('保存失败: ' + String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }

    const resetAll = async () => {
      setBusy(true)
      setMsg('')
      setMsgKind('')
      try {
        for (const group of FIELD_GROUPS) for (const f of group.fields) await scope.unset(f.key)
        setMsgKind('ok')
        setMsg('已恢复默认')
        setSeed((s) => s + 1)
      } catch (e) {
        setMsgKind('err')
        setMsg('恢复失败: ' + String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }

    const groups = FIELD_GROUPS.map((group) => {
      const rows = group.fields.map((f) => {
        const value = draft[f.key]
        let control
        if (f.kind === 'bool') {
          control = makeToggle(!!value, (next) => setField(f.key, next), busy || snap.writable === false)
        } else if (f.kind === 'num') {
          control = React.createElement(
            'div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            React.createElement('input', {
              type: 'number',
              value: value ?? '',
              disabled: busy || snap.writable === false,
              onChange: (e) => setField(f.key, e.target.value),
              title: f.hint,
              style: {
                width: 96, padding: '3px 6px', border: '1px solid ' + T.border, borderRadius: 4,
                background: 'transparent', color: T.text, fontSize: 12.5,
              },
            }),
            f.unit ? React.createElement('span', { style: { fontSize: 11, color: T.dim } }, f.unit) : null,
          )
        } else {
          control = React.createElement('input', {
            type: 'text',
            value: value ?? '',
            disabled: busy || snap.writable === false,
            onChange: (e) => setField(f.key, e.target.value),
            title: f.hint,
            style: {
              width: 180, padding: '3px 6px', border: '1px solid ' + T.border, borderRadius: 4,
              background: 'transparent', color: T.text, fontSize: 12.5,
            },
          })
        }
        return React.createElement(
          'label', { key: f.key, title: f.hint, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
          React.createElement('span', { style: { width: 150, fontSize: 12.5, color: T.text, flex: 'none' } }, f.label),
          control,
        )
      })
      return React.createElement(
        'div', { key: group.caption, style: { padding: '2px 14px' } },
        React.createElement('div', { style: { fontSize: 11, color: T.dim, margin: '8px 0 2px', letterSpacing: '.03em' } }, group.caption),
        ...rows,
      )
    })

    return React.createElement(
      'div', { style: card },
      React.createElement(
        'button', { type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open), style: headerStyle },
        React.createElement(
          'span', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
          React.createElement('span', { style: titleStyle }, 'think-summary'),
          React.createElement('span', { style: descStyle }, '长思考链分段总结 · 改动即时生效'),
        ),
        React.createElement('span', { style: chevron(open) }, '▾'),
      ),
      open
        ? React.createElement(
            'div', { style: { borderTop: '1px solid ' + T.border } },
            ...groups,
            React.createElement(
              'div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 12px' } },
              makeButton('保存', 'primary', () => void save(), busy),
              makeButton('恢复默认', 'secondary', () => void resetAll(), busy),
              msg
                ? React.createElement('span', { style: { fontSize: 12, color: msgKind === 'err' ? T.err : T.ok } }, msg)
                : (snap.writable === false
                    ? React.createElement('span', { style: { fontSize: 11.5, color: T.dim } }, '（Host 文档只读）')
                    : null),
            ),
          )
        : null,
    )
  }
}

/** 侧边栏"思考总结"：入口按钮 + 可折叠卡片（按每次思考分组，组内可折叠）。 */
function mountSidebarPanel() {
  const block = document.createElement('div')
  block.className = 'ts-block'
  block.dataset.dshThinksummaryBlock = ''

  const entry = document.createElement('button')
  entry.type = 'button'
  entry.className = 'ts-entry'
  entry.dataset.dshThinksummaryEntry = ''
  entry.setAttribute('aria-label', '思考总结')
  entry.innerHTML = ENTRY_ICON + '<span>思考总结</span>'

  const card = document.createElement('div')
  card.className = 'ts-card'
  card.hidden = true
  block.append(entry, card)

  const expanded = new Set()
  let cardOpen = false
  let lastState = null
  let alive = true
  let pollTimer = null

  const el = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  const render = () => {
    while (card.firstChild) card.removeChild(card.firstChild)
    const state = lastState
    if (!state) {
      card.appendChild(el('div', 'ts-placeholder', '尚无思考活动'))
      return
    }
    const thinks = state.thinks || []
    // 头部：状态 + 计数
    const head = el('div', 'ts-head')
    const dot = el('span', 'ts-dot')
    dot.style.background = state.active ? T.warn : T.ok
    if (state.active) dot.style.boxShadow = '0 0 0 3px ' + T.warn + '33'
    head.appendChild(dot)
    head.appendChild(el('span', null, state.active ? '思考中' : '思考结束'))
    head.appendChild(el('span', 'ts-head-tok', fmtTok(state.thinkingTokens) + ' tok'))
    const totalSegs = thinks.reduce((sum, t) => sum + t.segments.length, 0)
    head.appendChild(el('span', 'ts-head-tok', totalSegs + ' 段'))
    const refinedCount = thinks.reduce((sum, t) => sum + t.segments.filter((s) => s.refined).length, 0)
    if (refinedCount > 0) {
      head.appendChild(el('span', 'ts-seg-refined', refinedCount + ' 段已精炼'))
    }
    card.appendChild(head)

    const body = el('div', 'ts-body')
    card.appendChild(body)

    if (thinks.length === 0) {
      body.appendChild(el('div', 'ts-placeholder', '等待思考…'))
      return
    }
    thinks.forEach((t, thinkIndex) => {
      const thinkEl = el('div', 'ts-think')
      const open = expanded.has(t.id)
      thinkEl.dataset.open = open ? 'true' : 'false'
      const headBtn = el('button', 'ts-think-head')
      headBtn.type = 'button'
      headBtn.appendChild(el('span', 'ts-think-chevron', '▾'))
      headBtn.appendChild(el('span', 'ts-think-title', '第 ' + (thinkIndex + 1) + ' 次思考'))
      const status = el('span', 'ts-think-status', t.active ? '● 思考中' : '完成')
      status.style.color = t.active ? T.warn : T.dim
      headBtn.appendChild(status)
      headBtn.appendChild(el('span', 'ts-think-meta', fmtTok(t.tokens) + ' tok' + (t.segments.length ? ' · ' + t.segments.length + ' 段' : '')))
      headBtn.addEventListener('click', () => {
        if (expanded.has(t.id)) expanded.delete(t.id)
        else expanded.add(t.id)
        thinkEl.dataset.open = expanded.has(t.id) ? 'true' : 'false'
        const wrap = thinkEl.querySelector('.ts-think-segs')
        if (wrap) wrap.hidden = !expanded.has(t.id)
      })
      thinkEl.appendChild(headBtn)
      const segsWrap = el('div', 'ts-think-segs')
      segsWrap.hidden = !open
      if (t.segments.length === 0) {
        segsWrap.appendChild(el('div', 'ts-placeholder', '正在积累思考，达到段窗口后逐段出摘要…'))
      } else {
        t.segments.forEach((s) => {
          const row = el('div', 'ts-seg')
          row.appendChild(el('span', 'ts-seg-num', String(s.index + 1)))
          const sum = el('span', 'ts-seg-sum', s.summary)
          sum.title = '第' + (s.index + 1) + '段 · ' + s.tokens + ' tok'
          row.appendChild(sum)
          const metaEl = el('span', 'ts-seg-meta', s.refined ? '已精炼' : '')
          if (s.refined) metaEl.className = 'ts-seg-meta ts-seg-refined'
          row.appendChild(metaEl)
          segsWrap.appendChild(row)
        })
      }
      thinkEl.appendChild(segsWrap)
      body.appendChild(thinkEl)
    })
  }

  const poll = async () => {
    try {
      const res = await fetch(STATE_ROUTE)
      if (!res.ok) return
      const json = await res.json()
      if (!alive) return
      const state = (json && json.state) || null
      lastState = state
      if (state) {
        for (const t of state.thinks || []) if (t.active) expanded.add(t.id)
      }
      // 思考一开始就显示卡片（不等阈值）；结束后保留 KEEP_MS
      if (state && (state.active || Date.now() - (state.updatedAt || 0) < KEEP_MS)) {
        card.hidden = false
        entry.dataset.active = 'true'
      } else if (state && !cardOpen) {
        card.hidden = true
        delete entry.dataset.active
      }
      render()
    } catch {
      /* 轮询失败不影响聊天 */
    } finally {
      if (alive) {
        const idle = !lastState || (!lastState.active && Date.now() - (lastState.updatedAt || 0) >= KEEP_MS)
        pollTimer = setTimeout(poll, idle ? IDLE_POLL_MS : POLL_MS)
      }
    }
  }

  entry.addEventListener('click', () => {
    cardOpen = !cardOpen
    if (cardOpen) {
      card.hidden = false
      entry.dataset.active = 'true'
      if (lastState && lastState.thinks && lastState.thinks.length > 0) {
        expanded.add(lastState.thinks[lastState.thinks.length - 1].id)
      }
    } else if (!(lastState && (lastState.active || Date.now() - (lastState.updatedAt || 0) < KEEP_MS))) {
      card.hidden = true
      delete entry.dataset.active
    } else {
      delete entry.dataset.active
    }
    render()
  })

  // ---- 注入侧边栏（自愈，task-board 同款） ----
  const sidebarRoot = () => {
    const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (!column) return undefined
    const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
    return logoOwner || column.firstElementChild || undefined
  }
  const newSessionButton = (root) => {
    const nested = root.querySelector('button[class*="newSession"]')
    if (nested) return nested
    for (const child of root.children) if (child.tagName === 'BUTTON') return child
    return undefined
  }
  const place = (root) => {
    const button = newSessionButton(root)
    if (!button) return false
    if (block.parentElement !== root) {
      const row = button.closest('[class*="logoRow"]')
      const base = (row && row.parentElement === root) ? row : button
      const family = Array.from(root.children).filter(
        (node) => node instanceof HTMLElement && node.matches('[data-dsh-thinksummary-block], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'),
      )
      const anchor = family.length > 0 ? family[0] : base.nextElementSibling
      root.insertBefore(block, anchor)
    }
    return true
  }

  let root
  let placed = false
  const tryPlace = () => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(block)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root = root || sidebarRoot()
    if (root === undefined) return
    placed = place(root)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(block)) placed = place(root)
  })
  const waitObserver = new MutationObserver(() => tryPlace())
  waitObserver.observe(document.body, { childList: true, subtree: true })
  tryPlace()
  void poll()

  return () => {
    alive = false
    if (pollTimer !== null) clearTimeout(pollTimer)
    waitObserver.disconnect()
    rootObserver.disconnect()
    block.remove()
  }
}

export const name = 'dsh-think-summary'

export const inject = ['slots']

export function apply(ctx) {
  try {
    // 1) 设置卡片（官方插件配置区，直连自建设置桥）
    const scope = createBridgeScope()
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
      { name: 'settings.plugin.item', id: 'think-summary', order: 120, label: 'think-summary' },
      makeSettingsCard(scope),
    ))
    // 2) 侧边栏"思考总结"面板（按每次思考分组，初始即显示）
    if (typeof document !== 'undefined') {
      if (!document.querySelector('style[data-dsh-thinksummary-css]')) {
        const style = document.createElement('style')
        style.dataset.dshThinksummaryCss = ''
        style.textContent = PANEL_CSS
        document.head.appendChild(style)
      }
      const disposer = mountSidebarPanel()
      ctx.effect?.(() => disposer)
    }
  } catch (error) {
    // web shell 会因 apply 抛错而启动失败：外部插件必须吞掉
    console.error('[dsh-think-summary] client apply failed:', error)
  }
}
