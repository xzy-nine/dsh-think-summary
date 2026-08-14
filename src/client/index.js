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

/** 样式（注入一次 <style>；dock 面板配合输入框样式：input-major 背景 + 圆角 + dock 宽度公式）。 */
const PANEL_CSS = `
.ts-dock{flex:none;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto}
.ts-dock-panel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);box-shadow:var(--dsw-shadow-lv1);border-radius:12px;width:100%;overflow:hidden}
.ts-dock-head{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:transparent;border:none;border-radius:8px;align-items:center;gap:10px;padding:4px 12px;display:flex;transition:background-color 120ms ease}
.ts-dock-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .12s}
.ts-dock[data-open="true"] .ts-dock-chevron{transform:rotate(180deg)}
.ts-dock-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.ts-dock-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden}
.ts-dock-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.ts-dock-body{flex-direction:column;max-height:220px;padding:2px 0;display:flex;overflow-y:auto}
.ts-dock-seg{padding:6px 12px 6px 24px}
.ts-dock-seg + .ts-dock-seg{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-dock-seg-head{display:flex;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.ts-dock-placeholder{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-prev{display:flex;align-items:center;gap:6px;width:100%;padding:5px 12px;background:transparent;border:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-dock-prev:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-prev-chevron{transition:transform .12s}
.ts-dock-prev[aria-expanded="true"] .ts-dock-prev-chevron{transform:rotate(90deg)}
.ts-dock-prev-body{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-seg-refined{color:var(--dsw-alias-state-business-primary)}
.ts-seg-skip{color:var(--dsw-alias-label-tertiary)}
.ts-tail{margin:4px 16px 4px 30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ts-tail-head{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-tail-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-tail-chevron{transition:transform .12s;color:var(--dsw-alias-label-tertiary)}
.ts-tail[data-open="true"] .ts-tail-chevron{transform:rotate(180deg)}
.ts-tail-title{font-weight:600}
.ts-tail-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ts-tail-refined{color:var(--dsw-alias-state-business-primary);font-size:11px}
.ts-tail-body{border-top:1px solid var(--dsw-alias-separator-primary);max-height:320px;overflow-y:auto}
.ts-tail-seg{padding:6px 10px 6px 26px}
.ts-tail-seg + .ts-tail-seg{border-top:1px solid var(--dsw-alias-separator-primary)}
.ts-tail-seg-head{display:flex;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-tail-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
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
      { key: 'refineEnabled', label: '精炼', kind: 'bool', hint: '开启后所有可精炼分段都用最小模型精炼摘要' },
      {
        key: 'codeBlockMode', label: '代码块处理', kind: 'enum',
        options: [
          ['ignore', '忽略（不写内存，仅记行数）'],
          ['keep-skip', '保留 + 跳过精炼'],
          ['keep-refine', '保留并精炼'],
        ],
        hint: '忽略：代码内容不进内存、不精炼（省 token/内存），只留"代码块 · N 行"元信息',
      },
      {
        key: 'tableMode', label: '表格处理', kind: 'enum',
        options: [
          ['ignore', '忽略（不写内存，仅记行数）'],
          ['keep-skip', '保留 + 跳过精炼'],
          ['keep-refine', '保留并精炼'],
        ],
        hint: '忽略：表格内容不进内存、不精炼，只留"表格 · N 行"元信息',
      },
      {
        key: 'refineTrim', label: '精炼输入裁剪', kind: 'enum',
        options: [
          ['headtail', '头尾（保主题+结论，丢中段）'],
          ['tail', '仅尾部（丢主题，中段完整）'],
          ['full', '完整保留（不裁剪，信息最全）'],
        ],
        hint: '精炼输入预算内的裁剪策略；完整保留不裁剪但最耗 token',
      },
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

/** 段状态：代码段/表格段 → 结构化摘要（未精炼）；已精炼 → 已精炼；否则无标签。 */
function segStatus(s) {
  if (s && s.skipReason === 'code') return { cls: 'ts-seg-skip', label: '代码段·未精炼' }
  if (s && s.skipReason === 'table') return { cls: 'ts-seg-skip', label: '表格·未精炼' }
  if (s && s.refined) return { cls: 'ts-seg-refined', label: '已精炼' }
  return null
}

function segStatusEl(s) {
  const st = segStatus(s)
  return st ? React.createElement('span', { className: st.cls }, st.label) : null
}

/** 已精炼段的实际消耗标注：" · 精炼 ~N tok"（输入裁剪后 + 输出摘要）。 */
function refineTokStr(s) {
  if (!s || !s.refined) return ''
  const rt = s.refineTokens || {}
  const total = (rt.input || 0) + (rt.output || 0)
  return total > 0 ? ' · 精炼 ~' + fmtTok(total) + ' tok' : ''
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
        } else if (f.kind === 'enum') {
          control = React.createElement(
            'select',
            {
              value: value || (f.options && f.options[0] ? f.options[0][0] : ''),
              disabled: busy || snap.writable === false,
              onChange: (e) => setField(f.key, e.target.value),
              title: f.hint,
              style: {
                width: 210, padding: '3px 6px', border: '1px solid ' + T.border, borderRadius: 4,
                background: 'transparent', color: T.text, fontSize: 12.5,
              },
            },
            (f.options || []).map((o) => React.createElement('option', { key: o[0], value: o[0] }, o[1])),
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

/**
 * 聊天流内思考总结条（conversation.chat.turnTail）：
 * 在对应助手消息（一次思考 = 一个 step）输出下方渲染该 think 的分段摘要，
 * 可折叠、多行显示。匹配：sessionId + think.turn/step === 节点 turn/step。
 */
function makeThinkTail() {
  return function ThinkTail(props) {
    const sessionId = props && props.sessionId
    const turn = props && props.turn
    const seq = props && props.seq
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

/**
 * 输入框上方实时面板（conversation.input.dock）：
 * 样式配合输入框（input-major 背景 + dock 宽度公式）；可折叠、多行；
 * 只实时显示**当前这次思考**的每段摘要（思考中实时滚动，结束后短暂保留）。
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
    // 2) 聊天流内：对应助手消息输出下方的思考总结条（可折叠/多行）
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      { name: 'conversation.chat.turnTail', select: (owner) => (owner && owner.turn && typeof owner.turn.turn === 'number' ? { turn: owner.turn.turn } : null) },
      makeThinkTail(),
    ))
    // 3) 输入框上方实时面板（配合输入框样式；只显示当前思考）
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'think-summary.dock', order: 1 },
      makeInputDock(),
    ))
    // 4) 样式注入
    if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-thinksummary-css]')) {
      const style = document.createElement('style')
      style.dataset.dshThinksummaryCss = ''
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }
  } catch (error) {
    // web shell 会因 apply 抛错而启动失败：外部插件必须吞掉
    console.error('[dsh-think-summary] client apply failed:', error)
  }
}
