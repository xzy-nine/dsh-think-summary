/**
 * 设置卡片（settings.plugin.item 槽位）：默认折叠；分组字段 + 控件 + 保存/恢复。
 * 布局与视觉对齐**原生 dsh 设置卡**（PluginCard + ValueField）：
 *  - 卡片 radius 12、展开 bg-layer-2、hover 边框 dimmed
 *  - 字段纵向：label 行（label + 单位 pill）→ 控件（34px 输入/下拉/文本域）→ hint
 *  - 保存 = 反色主按钮，恢复 = 描边次按钮；bool = 原生小开关
 * 数据经自建设置桥（createBridgeScope）读写——官方桥只服务白名单命名空间，
 * 独立第三方插件必须自带 loopback 桥（docs/probe-notes.md §6）。
 */

/** 设置卡片字段定义（与 Host schema 对齐；分组渲染）。
 * `enabled`（插件总开关）不在此列——它渲染为卡片顶部的独立总开关。 */
const FIELD_GROUPS = [
  {
    caption: '精炼模型',
    fields: [
      { key: 'refineEnabled', label: '精炼', kind: 'bool', hint: '开启后用所选模型给每个分段写摘要' },
      {
        key: 'refineModels', label: '模型池', kind: 'pool',
        hint: '添加多个「供应商/模型」，摘要与翻译**轮流**取用；每模型各自并发、失败自动退避并由其他模型顶上（免费模型建议多加几个）',
      },
      { key: 'poolPerModelConcurrency', label: '每模型并发', kind: 'num', unit: '', hint: '每个模型各自的并发上限；免费模型普遍限流，填 1 最稳' },
      { key: 'poolMaxAttempts', label: '换模型重试', kind: 'num', unit: '轮', hint: '单个任务最多试几轮（每轮可能换一个模型）；全失败才写回错误' },
      { key: 'refineTimeout', label: '超时', kind: 'num', unit: 's', hint: '单任务超时（秒）；卡死的任务超时放弃并释放并发位' },
      { key: 'refineDisableReasoning', label: '关闭思考', kind: 'bool', hint: '请求带 reasoningEffort=off，省掉推理开销；只在该模型声明了 off 档位时发送（供应商需 compat.supportsReasoningEffort: true + 模型 reasoningEfforts.off），否则静默不发' },
    ],
  },
  {
    caption: '单模型回退（模型池为空时用）',
    fields: [
      { key: 'refineProvider', label: '供应商', kind: 'provider', hint: 'auto = 跟随主请求供应商；模型池非空时此项被忽略' },
      { key: 'refineModel', label: '模型', kind: 'model', hint: 'auto = 所选供应商目录中上下文窗口最小的可用模型；模型池非空时此项被忽略' },
      { key: 'refineConcurrency', label: '并发', kind: 'num', unit: '', hint: '单模型模式下的并行精炼数；模型池模式改用「每模型并发」× 模型数' },
    ],
  },
  {
    caption: '分段',
    fields: [
      { key: 'segmentMinTokens', label: '段最小窗口', kind: 'num', unit: 'tok', hint: '达到后才允许切段（等语义边界信号）' },
      { key: 'segmentMaxTokens', label: '段硬上限', kind: 'num', unit: 'tok', hint: '到点强制切（回溯到句末/行末），保证缓冲有界' },
    ],
  },
  {
    caption: '提示词',
    fields: [
      { key: 'refinePrompt', label: '分段摘要', kind: 'area', hint: '第一遍：每个分段 → 一句中文第一人称动向；片段的包裹与"要求后置"由代码固定' },
      { key: 'refineThinkPrompt', label: '整体摘要', kind: 'area', hint: '第二遍：把分段摘要合并成整次思考的一句话（≥2 段才跑）' },
      { key: 'todoTranslatePrompt', label: '任务翻译', kind: 'area', hint: '看板上的「翻译为中文」按钮用它：请求给哪几条就翻哪几条，译成简短中文（每行一条、顺序与行数不变，客户端拼成"原文（中文）"）' },
    ],
  },
  {
    caption: '存储与清理',
    fields: [
      { key: 'persistEnabled', label: '持久化保存', kind: 'bool', hint: '保存思考总结到磁盘（~/.dsh/dsh-think-summary.json），重启 dsh 后仍可查看历史总结' },
      { key: 'autoCleanArchived', label: '自动清理', kind: 'bool', hint: '定期清理已归档（非活跃）会话的思考总结，避免磁盘无限增长' },
      { key: 'autoCleanArchivedDays', label: '归档保留天数', kind: 'num', unit: '天', hint: '会话归档（非活跃）超过该天数后自动清理其思考总结' },
    ],
  },
  {
    caption: '高级（一般不用动）',
    fields: [
      { key: 'thinkThresholdTokens', label: '长思考阈值', kind: 'num', unit: 'tok', hint: '0 = 不门控：任何思考都分段总结；调大则只在超长思考时产出（原作者默认 2000）' },
      { key: 'refineMinTokens', label: '精炼最小段', kind: 'num', unit: 'tok', hint: '低于该值的段跳过精炼；0 = 每段都精炼' },
      { key: 'refineOutputTokens', label: '精炼预算', kind: 'num', unit: 'tok', hint: 'API 完成预算（推理+答案）；关思考的模型 512 足够，未关思考的推理型建议 ≥1024' },
      { key: 'refineMaxInputTokens', label: '精炼输入预算', kind: 'num', unit: 'tok', hint: '喂给小模型的段文本预算（按下方裁剪策略裁剪后）' },
      {
        key: 'refineTrim', label: '精炼输入裁剪', kind: 'enum',
        options: [
          ['headtail', '头尾（保主题+结论，丢中段）'],
          ['tail', '仅尾部（丢主题，中段完整）'],
          ['full', '完整保留（不裁剪，信息最全）'],
        ],
        hint: '精炼输入预算内的裁剪策略；完整保留不裁剪但最耗 token',
      },
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
        key: 'selfSummary', label: '主模型自产小结', kind: 'enum',
        options: [
          ['off', '关闭'],
          ['prompt', '注入提示词并捕获'],
        ],
        hint: '向系统提示词注入小结指令，模型输出【思考小结】标记时流内捕获直接展示（会改变主模型思考方式）',
      },
    ],
  },
]

/** 开关（视觉 switch，实际是带 aria 的 button）——原来的大圆角开关样式。 */
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
      className: 'ts-set-toggle',
    },
    React.createElement('span', { className: 'ts-set-toggle-thumb' }),
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
    const [cleanBusy, setCleanBusy] = React.useState(false)
    // 精炼供应商/模型下拉：已注册供应商目录 + 每个供应商的可用模型 + 当前会话模型
    const [providers, setProviders] = React.useState([])
    const [modelsByProvider, setModelsByProvider] = React.useState({})
    const [currentProvider, setCurrentProvider] = React.useState('')
    const [currentModel, setCurrentModel] = React.useState('')
    // 分组折叠状态：默认全部折叠
    const [groupOpen, setGroupOpen] = React.useState({})
    // 模型池的"待添加"选择（供应商 + 模型），点「添加」才进池子
    const [poolDraft, setPoolDraft] = React.useState({ provider: '', model: '' })

    // 加载精炼供应商/模型下拉数据（/models 路由：providers + 各自的模型目录）
    React.useEffect(() => {
      let alive = true
      const load = async () => {
        try {
          const response = await fetch(MODELS_ROUTE)
          if (!response.ok) return
          const json = await response.json()
          if (!alive || !json || json.ok !== true) return
          if (Array.isArray(json.providers)) setProviders(json.providers)
          if (json.modelsByProvider && typeof json.modelsByProvider === 'object') setModelsByProvider(json.modelsByProvider)
          if (typeof json.provider === 'string') setCurrentProvider(json.provider)
          if (typeof json.current === 'string') setCurrentModel(json.current)
        } catch {
          /* 目录不可用：下拉只剩"自动" */
        }
      }
      void load()
      return () => { alive = false }
    }, [])

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
        // 插件总开关（独立于分组，默认开）
        next.enabled = v.enabled === undefined ? true : !!v.enabled
        for (const group of FIELD_GROUPS) {
          for (const f of group.fields) {
            if (f.kind === 'bool') {
              next[f.key] = v[f.key] === undefined ? true : !!v[f.key]
            } else if (f.kind === 'pool') {
              // 模型池：数组原样保留（空数组 = 未配置 → 走单模型回退）
              next[f.key] = Array.isArray(v[f.key]) ? v[f.key].slice() : []
            } else {
              next[f.key] = v[f.key] === undefined
                ? (b[f.key] === undefined ? '' : String(b[f.key]))
                : String(v[f.key])
            }
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
        await scope.set('enabled', !!draft.enabled)
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
            } else if (f.kind === 'pool') {
              // 空数组就 unset（回默认 []），保持设置文件干净
              const list = Array.isArray(draft[f.key]) ? draft[f.key] : []
              if (list.length === 0) await scope.unset(f.key)
              else await scope.set(f.key, list)
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
        await scope.unset('enabled')
        for (const group of FIELD_GROUPS) for (const f of group.fields) {
          // 数组字段：unset 即可回到默认 []（scope.unset 不能传数组）
          await scope.unset(f.key)
        }
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

    // 立即清理已归档（非活跃）会话的思考总结
    const clearArchived = async () => {
      setCleanBusy(true)
      setMsg('')
      setMsgKind('')
      try {
        const res = await fetch(CLEAR_ARCHIVED_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        const json = await res.json()
        if (json && json.ok) {
          setMsgKind('ok')
          setMsg('已清理 ' + (json.removed ?? 0) + ' 个已归档会话的总结' + (json.persisted ? '' : '（未持久化）'))
        } else {
          setMsgKind('err')
          setMsg('清理失败: ' + String((json && json.message) || '未知错误'))
        }
      } catch (e) {
        setMsgKind('err')
        setMsg('清理失败: ' + String((e && e.message) || e))
      } finally {
        setCleanBusy(false)
      }
    }

    // 插件总开关行（渲染在分组之上）：关闭后不检测/不精炼/不显示总结 UI
    const disabled = busy || snap.writable === false
    const masterField = React.createElement(
      'div', { key: '__master__', className: 'ts-set-field' },
      React.createElement(
        'div', { className: 'ts-set-head' },
        React.createElement('label', { className: 'ts-set-label' }, '启用插件'),
        makeToggle(!!draft.enabled, (next) => setField('enabled', next), disabled),
      ),
      React.createElement('p', { className: 'ts-set-hint' }, '插件总开关：关闭后停止检测与分段（含精炼），输入框上方与对话中的总结卡片都不显示'),
    )

    const groups = FIELD_GROUPS.map((group) => {
      // 分组折叠：默认折叠（groupOpen[group.caption] !== true）
      const expanded = groupOpen[group.caption] === true
      const toggleGroup = () => setGroupOpen((m) => ({ ...m, [group.caption]: !(m[group.caption] === true) }))
      const rows = group.fields.map((f) => {
        const value = draft[f.key]

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
        if (f.kind === 'bool') {
          control = null // 开关已渲染在 label 行，绝不能落入下方 else 的文本框
        } else if (f.kind === 'num') {
          control = React.createElement('input', {
            type: 'text', inputMode: 'numeric', className: 'ts-set-input', value: value ?? '',
            disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
          })
        } else if (f.kind === 'area') {
          control = React.createElement('textarea', {
            className: 'ts-set-textarea', rows: 3, value: value ?? '',
            disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
          })
        } else if (f.kind === 'pool') {
          // 模型池：每个已添加的模型一个气泡（**只显示模型名**，完整
          // `供应商/模型` 放悬停提示），右侧 × 移除；下面一行是"供应商 + 模型 + 添加"。
          const list = Array.isArray(value) ? value : []
          const chips = React.createElement(
            'div', { className: 'ts-pool-chips' },
            list.length === 0
              ? React.createElement('span', { className: 'ts-pool-empty' }, '未添加模型（将回退下面的单模型设置）')
              : list.map((entry, index) => {
                const text = String(entry)
                const slash = text.indexOf('/')
                // 气泡上只留模型名；没有斜杠就原样显示（容错：设置文件可能被手改）
                const short = slash > 0 && slash < text.length - 1 ? text.slice(slash + 1) : text
                return React.createElement(
                  'span', { key: text + ':' + index, className: 'ts-pool-chip', title: text },
                  React.createElement('span', { className: 'ts-pool-chip-text' }, short),
                  React.createElement('button', {
                    type: 'button', className: 'ts-pool-chip-del',
                    disabled, title: '移除该模型',
                    onClick: () => setField(f.key, list.filter((_, i) => i !== index)),
                  }, '×'),
                )
              }),
          )
          const pickerProvider = poolDraft.provider || (providers[0] && providers[0].id) || ''
          const pickerModels = Array.isArray(modelsByProvider[pickerProvider]) ? modelsByProvider[pickerProvider] : []
          const pickerModel = pickerModels.includes(poolDraft.model) ? poolDraft.model : (pickerModels[0] || '')
          control = React.createElement(
            React.Fragment, null,
            chips,
            React.createElement(
              'div', { className: 'ts-pool-add' },
              React.createElement(
                'select',
                {
                  className: 'ts-set-input', value: pickerProvider, disabled, title: '选择供应商',
                  onChange: (e) => setPoolDraft((d) => ({ ...d, provider: e.target.value, model: '' })),
                },
                providers.length === 0
                  ? React.createElement('option', { value: '' }, '（无可用供应商）')
                  : providers.map((p) => React.createElement('option', { key: p.id, value: p.id }, p.id + (p.name && p.name !== p.id ? '（' + p.name + '）' : ''))),
              ),
              React.createElement(
                'select',
                {
                  className: 'ts-set-input', value: pickerModel, disabled, title: '选择模型',
                  onChange: (e) => setPoolDraft((d) => ({ ...d, model: e.target.value })),
                },
                pickerModels.length === 0
                  ? React.createElement('option', { value: '' }, '（无可用模型）')
                  : pickerModels.map((m) => React.createElement('option', { key: m, value: m }, m)),
              ),
              React.createElement(
                'button',
                {
                  type: 'button', className: 'ts-pool-add-btn',
                  disabled: disabled || pickerProvider === '' || pickerModel === '',
                  title: '把该模型加入池子',
                  onClick: () => {
                    if (pickerProvider === '' || pickerModel === '') return
                    const ref = pickerProvider + '/' + pickerModel
                    if (list.includes(ref)) return // 去重：同一个模型不加两次
                    setField(f.key, list.concat([ref]))
                  },
                },
                '添加',
              ),
            ),
            React.createElement('p', { className: 'ts-set-hint' }, '已添加 ' + list.length + ' 个模型：摘要与翻译轮流取用，各自独立并发与退避'),
          )
        } else if (f.kind === 'enum') {
          control = React.createElement(
            'select',
            {
              className: 'ts-set-input', value: value || (f.options && f.options[0] ? f.options[0][0] : ''),
              disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
            },
            (f.options || []).map((o) => React.createElement('option', { key: o[0], value: o[0] }, o[1])),
          )
        } else if (f.kind === 'provider') {
          // 精炼供应商下拉：'auto'（跟随主请求供应商）+ 已注册供应商目录
          const cur = value || 'auto'
          const opts = [['auto', '自动（跟随主请求' + (currentProvider ? '：' + currentProvider : '') + '）']]
          const seen = new Set(['auto'])
          for (const p of providers) {
            const id = p && typeof p.id === 'string' ? p.id : ''
            if (id.length === 0 || seen.has(id)) continue
            seen.add(id)
            const name = p && typeof p.name === 'string' && p.name.length > 0 && p.name !== id ? id + '（' + p.name + '）' : id
            opts.push([id, name])
          }
          // 保存值不在目录（如供应商已卸载）：保留为额外选项，便于改回
          if (!seen.has(cur)) opts.push([cur, cur + '（未注册）'])
          control = React.createElement(
            'select',
            {
              className: 'ts-set-input', value: cur,
              disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
            },
            opts.map((o) => React.createElement('option', { key: o[0], value: o[0] }, o[1])),
          )
        } else if (f.kind === 'model') {
          // 精炼模型下拉：'auto' + 所选供应商的可用模型列表（供应商为 auto 时用当前会话供应商）
          const cur = value || 'auto'
          const providerValue = draft.refineProvider || 'auto'
          const effectiveProvider = providerValue === 'auto' ? currentProvider : providerValue
          const available = Array.isArray(modelsByProvider[effectiveProvider]) ? modelsByProvider[effectiveProvider] : []
          const autoLabel = providerValue === 'auto'
            ? '自动（' + (currentModel || '最小可用模型') + '）'
            : '自动（' + effectiveProvider + ' 最小可用模型）'
          const opts = [['auto', autoLabel]]
          const seen = new Set(['auto'])
          for (const m of available) {
            if (typeof m === 'string' && m.length > 0 && !seen.has(m)) {
              seen.add(m)
              opts.push([m, m])
            }
          }
          // 保存值不在列表（如旧自定义值/已切换供应商）：保留为额外选项
          if (!seen.has(cur)) opts.push([cur, cur])
          const currentNote = cur === 'auto' && currentModel && providerValue === 'auto'
            ? React.createElement('p', { className: 'ts-set-hint' }, '当前会话模型：' + currentProvider + ' / ' + currentModel + '（精炼将自动选用最小可用模型）')
            : null
          control = React.createElement(
            React.Fragment, null,
            React.createElement(
              'select',
              {
                className: 'ts-set-input', value: cur,
                disabled, title: f.hint, onChange: (e) => setField(f.key, e.target.value),
              },
              opts.map((o) => React.createElement('option', { key: o[0], value: o[0] }, o[1])),
            ),
            currentNote,
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
      // "存储与清理"组末尾：立即清理已归档总结
      const cleanRow = group.caption === '存储与清理'
        ? React.createElement(
            'div', { key: '__clean__', className: 'ts-set-field' },
            React.createElement(
              'div', { className: 'ts-set-head' },
              React.createElement('label', { className: 'ts-set-label' }, '立即清理'),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'ts-set-discard',
                  disabled: cleanBusy || snap.writable === false,
                  onClick: () => void clearArchived(),
                },
                cleanBusy ? '清理中…' : '清理已归档总结',
              ),
            ),
            React.createElement('p', { className: 'ts-set-hint' }, '删除所有非活跃会话的思考总结（含磁盘持久化数据），运行中的会话不受影响'),
          )
        : null
      return React.createElement(
        'div', { key: group.caption, className: 'ts-set-group', 'data-open': expanded ? 'true' : 'false' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ts-set-group-head',
            'aria-expanded': expanded ? 'true' : 'false',
            onClick: toggleGroup,
          },
          React.createElement('span', { className: 'ts-set-caption' }, group.caption),
          chevronEl('ts-set-group-chevron'),
        ),
        expanded ? [...rows, cleanRow].filter(Boolean) : null,
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
        chevronEl('ts-set-chevron'),
      ),
      open
        ? React.createElement(
            'div', { className: 'ts-set-body' },
            masterField,
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
