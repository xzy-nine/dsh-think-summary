/**
 * 设置卡片（settings.plugin.item 槽位）：默认折叠；分组字段 + 控件 + 保存/恢复。
 * 布局与视觉对齐**原生 dsh 设置卡**（PluginCard + ValueField）：
 *  - 卡片 radius 12、展开 bg-layer-2、hover 边框 dimmed
 *  - 字段纵向：label 行（label + 单位 pill）→ 控件（34px 输入/下拉/文本域）→ hint
 *  - 保存 = 反色主按钮，恢复 = 描边次按钮；bool = 原生小开关
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
      { key: 'refineConcurrency', label: '精炼并发', kind: 'num', unit: '', hint: '并行精炼数；并发执行，任务之间互不打断' },
      { key: 'refineTimeout', label: '精炼超时', kind: 'num', unit: 's', hint: '单任务超时（秒）；卡死任务超时放弃并释放并发位' },
      { key: 'refineModel', label: '精炼模型', kind: 'text', hint: "'auto' = 最小可用模型；可显式指定" },
      { key: 'refinePrompt', label: '精炼提示词', kind: 'area', hint: '精炼时发给模型的 system 提示词（可修改，留空恢复默认）' },
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

/** 原生小开关（对齐 trajectory controlTrack：track 20×10、thumb 6×6）。 */
function makeToggle(on, onChange, disabled) {
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      'data-on': on ? 'true' : 'false',
      disabled: !!disabled,
      onClick: () => onChange(!on),
      className: 'ts-set-switch',
    },
    React.createElement('span', { className: 'ts-set-switch-track' },
      React.createElement('span', { className: 'ts-set-switch-thumb' })),
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

/** 设置卡片：默认折叠，点头部展开；对齐原生 PluginCard + ValueField 布局。 */
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
        const b = snap.base || {}
        const next = {}
        for (const group of FIELD_GROUPS) {
          for (const f of group.fields) {
            next[f.key] = f.kind === 'bool'
              ? (v[f.key] === undefined ? true : !!v[f.key])
              : (v[f.key] === undefined ? (b[f.key] === undefined ? '' : String(b[f.key])) : String(v[f.key]))
          }
        }
        setDraft(next)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap, busy, seed])

    if (!snap || snap.status === 'loading') return null

    if (snap.status === 'unavailable') {
      return React.createElement(
        'div', { className: 'ts-set-card' },
        React.createElement('div', { className: 'ts-set-header' },
          React.createElement('div', { className: 'ts-set-headText' },
            React.createElement('span', { className: 'ts-set-name' }, 'think-summary'),
            React.createElement('span', { className: 'ts-set-desc' }, '设置桥不可用：宿主未运行本插件的 Host 半面。'),
          ),
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

    const groups = FIELD_GROUPS.map((group, gi) => {
      const rows = group.fields.map((f) => {
        const value = draft[f.key]
        const disabled = busy || snap.writable === false

        // label 行：label + 单位 pill（bool 时右侧放开关）
        const headRight = f.kind === 'bool'
          ? makeToggle(!!value, (next) => setField(f.key, next), disabled)
          : f.unit
            ? React.createElement('span', { className: 'ts-set-unit' }, f.unit)
            : null
        const head = React.createElement(
          'div', { className: 'ts-set-head' },
          React.createElement('label', { className: 'ts-set-label' }, f.label),
          headRight,
        )

        // 控件：bool 无独立控件行（开关在 label 行）；其余 34px 控件在 label 下
        let control = null
        if (f.kind === 'num') {
          control = React.createElement('input', {
            type: 'text', inputMode: 'numeric', className: 'ts-set-input', value: value ?? '',
            disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
          })
        } else if (f.kind === 'area') {
          control = React.createElement('textarea', {
            className: 'ts-set-textarea', rows: 3, value: value ?? '',
            disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
          })
        } else if (f.kind === 'enum') {
          control = React.createElement(
            'select',
            {
              className: 'ts-set-input', value: value || (f.options && f.options[0] ? f.options[0][0] : ''),
              disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
            },
            (f.options || []).map((o) => React.createElement('option', { key: o[0], value: o[0] }, o[1])),
          )
        } else {
          control = React.createElement('input', {
            type: 'text', className: 'ts-set-input', value: value ?? '',
            disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
          })
        }

        return React.createElement(
          'div', { key: f.key, className: 'ts-set-field' },
          head,
          control,
          React.createElement('p', { className: 'ts-set-hint' }, f.hint),
        )
      })
      return React.createElement(
        'div', { key: group.caption, className: 'ts-set-group' },
        React.createElement('div', { className: 'ts-set-caption' }, group.caption),
        ...rows,
      )
    })

    return React.createElement(
      'div', { className: 'ts-set-card', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'ts-set-header',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
        },
        React.createElement('div', { className: 'ts-set-headText' },
          React.createElement('span', { className: 'ts-set-name' }, 'think-summary'),
          React.createElement('span', { className: 'ts-set-desc' }, '长思考链分段总结 · 改动即时生效'),
        ),
        React.createElement('span', { className: 'ts-set-chevron' }, '▾'),
      ),
      open
        ? React.createElement(
            'div', { className: 'ts-set-body' },
            ...groups,
            React.createElement(
              'div', { className: 'ts-set-footer' },
              msg
                ? React.createElement('p', { className: 'ts-set-msg', 'data-kind': msgKind }, msg)
                : (snap.writable === false
                    ? React.createElement('p', { className: 'ts-set-msg' }, '（Host 文档只读）')
                    : React.createElement('p', { className: 'ts-set-msg' }, '')),
              React.createElement('button', { type: 'button', className: 'ts-set-discard', disabled: busy, onClick: () => void resetAll() }, '恢复默认'),
              React.createElement('button', { type: 'button', className: 'ts-set-save', disabled: busy, onClick: () => void save() }, '保存'),
            ),
          )
        : null,
    )
  }
}
