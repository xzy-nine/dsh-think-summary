/**
 * dsh-think-summary web client（纯 JS，由 scripts/build-client.mjs 打包为
 * ModuleLoader bundle）。不依赖 JSX/TS——React 来自 bundle 包裹层的
 * `require("react")`，经 react 自由变量使用。
 *
 * 职责：
 *  1. settings.plugin.item 设置卡片：编辑 think-summary 配置（自建设置桥）
 *  2. conversation.input.dock 实时面板：轮询 /api/think-summary/state 展示分段摘要
 *
 * 视觉：全部走 dsh 主题变量（--dsw-alias-*，带降级色），与官方 UI 一致。
 * 失败策略：任何 DOM/网络异常只记录，绝不向上抛（web shell 会因插件 apply
 * 抛错而整个启动失败）。
 */
const NS = 'think-summary'
const STATE_ROUTE = '/api/think-summary/state'
const SETTINGS_PREFIX = '/api/think-summary/settings'

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

/** 通用小组件：开关（视觉 switch，实际是带 aria 的 button）。 */
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

/** 按钮。 */
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
 * 与官方 SettingsScope 同构：getSnapshot/subscribe/set/unset。
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

/** 设置卡片：卡片化布局 + 分组字段 + 开关/单位/按钮/状态。 */
function makeSettingsCard(scope) {
  return function SettingsCard() {
    const [snap, setSnap] = React.useState(null)
    const [draft, setDraft] = React.useState({})
    const [busy, setBusy] = React.useState(false)
    const [msg, setMsg] = React.useState('')
    const [msgKind, setMsgKind] = React.useState('')
    const [seed, setSeed] = React.useState(0)
    // 顶层折叠：与其他插件卡片一致，默认收起，点头部展开
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
      const sync = () => setSnap(scope.getSnapshot())
      sync()
      const un = scope.subscribe(sync)
      return () => { if (typeof un === 'function') un() }
    }, [])

    // 快照变化（含保存后回读）时，若不在保存中则重新铺草稿
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
          React.createElement('span', { style: descStyle }, '长思考链检测、分段与逐段摘要 · 改动即时生效'),
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

/** 实时面板：轮询 Host 路由，展示思考进度与分段摘要（最近 MAX_VISIBLE 段）。 */
const POLL_MS = 1500
const IDLE_POLL_MS = 5000
const IDLE_AFTER_MS = 30000
const MAX_VISIBLE = 8

function makePanel() {
  return function ThinkPanel(props) {
    const [state, setState] = React.useState(null)
    const sessionId = props && props.sessionId

    React.useEffect(() => {
      if (!sessionId) return undefined
      let alive = true
      let timer = null
      const poll = async () => {
        let view = null
        try {
          const res = await fetch(STATE_ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
          if (!res.ok) return
          const json = await res.json()
          if (!alive) return
          view = (json && json.state) || null
          setState(view)
        } catch {
          /* 轮询失败不影响聊天 */
        } finally {
          if (!alive) return
          const idle = !view || (!view.active && Date.now() - (view.updatedAt || 0) >= IDLE_AFTER_MS)
          timer = setTimeout(poll, idle ? IDLE_POLL_MS : POLL_MS)
        }
      }
      void poll()
      return () => { alive = false; if (timer !== null) clearTimeout(timer) }
    }, [sessionId])

    if (!state || !state.inSplice) return null

    const card = { border: '1px solid ' + T.border, borderRadius: 6, background: T.bg, overflow: 'hidden', color: T.text, fontSize: 12 }
    const headerStyle = {
      display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px',
      borderBottom: '1px solid ' + T.border,
    }
    const dot = (color) => ({
      width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none',
      ...(state.active ? { boxShadow: '0 0 0 3px ' + color + '33' } : {}),
    })
    const refined = (state.segments || []).filter((s) => s.refined).length
    const segments = (state.segments || []).slice(-MAX_VISIBLE)

    const segRows = segments.map((s) => {
      const metaParts = []
      metaParts.push(fmtTok(s.tokens) + ' tok')
      if (s.refined) metaParts.push('已精炼')
      return React.createElement(
        'div', {
          key: s.index + ':' + s.ts,
          title: '第' + (s.index + 1) + '段 · ' + s.tokens + ' tok' + (s.refined ? ' · 已精炼' : ''),
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' },
        },
        React.createElement('span', {
          style: {
            flex: 'none', minWidth: 18, height: 18, borderRadius: 9, background: T.hover,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10.5, color: T.dim, fontWeight: 600,
          },
        }, String(s.index + 1)),
        React.createElement('span', {
          style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: T.text, fontSize: 12 },
        }, s.summary),
        React.createElement('span', { style: { flex: 'none', fontSize: 10.5, color: T.dim, whiteSpace: 'nowrap' } }, metaParts.join(' · ')),
      )
    })

    return React.createElement(
      'div', { style: { ...card, margin: '2px 0' } },
      React.createElement(
        'div', { style: headerStyle },
        React.createElement('span', { style: dot(state.active ? T.warn : T.ok) }),
        React.createElement('span', { style: { fontWeight: 600, color: T.text } }, state.active ? '思考中' : '思考结束'),
        React.createElement('span', { style: { color: T.dim, fontVariantNumeric: 'tabular-nums' } }, fmtTok(state.thinkingTokens) + ' tok'),
        React.createElement('span', { style: { color: T.dim } }, (state.segments || []).length + ' 段'),
        refined > 0
          ? React.createElement('span', { style: { color: T.accent, fontSize: 11 } }, refined + ' 段已精炼')
          : null,
      ),
      segRows.length > 0
        ? segRows
        : React.createElement('div', { style: { padding: '5px 10px', color: T.dim } }, '正在积累思考，达到段窗口后逐段出摘要…'),
    )
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
    // 2) 实时面板（composer 上方整行）
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'think-summary.panel' },
      makePanel(),
    ))
  } catch (error) {
    // web shell 会因 apply 抛错而启动失败：外部插件必须吞掉
    console.error('[dsh-think-summary] client apply failed:', error)
  }
}
