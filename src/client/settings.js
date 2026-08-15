/**
 * 设置卡片（settings.plugin.item 槽位）：默认折叠；分组字段 + 控件 + 保存/恢复。
 * 数据经自建设置桥（createBridgeScope）读写——官方桥只服务白名单命名空间，
 * 独立第三方插件必须自带 loopback 桥（docs/probe-notes.md §6）。
 */

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
        hint: '忽略：代码内容不进内存、不精炼（省 token/内存），总结卡片不显示代码块痕迹',
      },
      {
        key: 'tableMode', label: '表格处理', kind: 'enum',
        options: [
          ['ignore', '忽略（不写内存，仅记行数）'],
          ['keep-skip', '保留 + 跳过精炼'],
          ['keep-refine', '保留并精炼'],
        ],
        hint: '忽略：表格内容不进内存、不精炼，总结卡片不显示表格痕迹',
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
  {
    caption: '主模型自产小结',
    fields: [
      {
        key: 'selfSummary', label: '模式', kind: 'enum',
        options: [
          ['off', '关闭'],
          ['prompt', '注入提示词并捕获'],
        ],
        hint: '向系统提示词注入小结指令，思考时模型输出【思考小结】标记，插件流内捕获直接展示（默认关：会改变主模型思考方式，需实测）',
      },
    ],
  },
]

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
