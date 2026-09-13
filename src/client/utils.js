/**
 * 展示/解析小工具（tail.js、dock.js、settings.js 共用）。
 */
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

/** 段状态：主模型小结 → 小结标签；代码段/表格段 → 结构化摘要（未精炼）；未精炼原因 → 原因标签；待精炼 → 待精炼；已精炼 → 已精炼。 */
function segStatus(s) {
  if (s && s.kind === 'self') return { cls: 'ts-seg-self', label: '思考小结' }
  if (s && s.skipReason === 'code') return { cls: 'ts-seg-skip', label: '代码段·未精炼' }
  if (s && s.skipReason === 'table') return { cls: 'ts-seg-skip', label: '表格·未精炼' }
  if (s && s.refined) return { cls: 'ts-seg-refined', label: '已精炼' }
  if (s && s.unrefinedReason) return { cls: 'ts-seg-skip', label: s.unrefinedReason }
  if (s && !s.kind) return { cls: 'ts-seg-pending', label: '待精炼' }
  return null
}

function segStatusEl(s) {
  const st = segStatus(s)
  return st ? React.createElement('span', { className: st.cls }, st.label) : null
}

/** 已精炼段的实际消耗标注：" · 精炼 in/out"（输入裁剪后 + 输出摘要）。 */
function refineTokStr(s) {
  if (!s || !s.refined) return ''
  const rt = s.refineTokens || {}
  const input = rt.input || 0
  const output = rt.output || 0
  if (input <= 0 && output <= 0) return ''
  return ' · 精炼 ' + fmtTok(input) + '→' + fmtTok(output) + ' tok'
}

/**
 * 段头标签：主模型小结 → "小结"；普通段 → "原始 X tok[ · 精炼 ~Y tok]"。
 * 原始 token 用 rawTokens（段文本 + 本段之前被忽略的代码/表格 token，
 * 精炼前/忽略前的完整口径）；无 rawTokens 时回退到段文本 token。
 */
function segHeadLabel(s, prefix) {
  if (s && s.kind === 'self') return prefix + '第' + (s.index + 1) + '段 · 小结'
  const raw = (s && (s.rawTokens ?? s.tokens)) || 0
  return prefix + '第' + (s.index + 1) + '段 · 原始 ' + fmtTok(raw) + ' tok' + refineTokStr(s)
}

/**
 * 轮询会话思考状态（dock/views 共用）。
 * 每 1.5s fetch STATE_ROUTE；返回 { state, enabled, paused }。
 */
function useThinkState(sessionId) {
  const [state, setState] = React.useState(null)
  const [enabled, setEnabled] = React.useState(true)
  const [paused, setPaused] = React.useState(false)
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
        setEnabled(!json || json.enabled !== false)
        setPaused(!json || json.paused === true)
        setState((json && json.state) || null)
      } catch {
        /* 轮询失败不影响 */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  return { state, enabled, paused }
}

/**
 * 原生 dsh chevron-down-outline-14 图标（对齐默认箭头，非实心字符）。
 * 路径取自 dsh-client-ui-primitives IconChevronDownOutline14；颜色跟 currentColor，
 * 由使用处 CSS class 控制；旋转交给父级 class 的 transform。
 */
function chevronEl(className) {
  return React.createElement(
    'svg',
    {
      className, width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor',
      'aria-hidden': 'true', style: { flex: 'none' },
    },
    React.createElement('path', {
      d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
    }),
  )
}

/** 原生 dsh chevron-right-outline-14 图标（dock 内"上次思考"折叠行箭头）。 */
function chevronRightEl(className) {
  return React.createElement(
    'svg',
    {
      className, width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor',
      'aria-hidden': 'true', style: { flex: 'none' },
    },
    React.createElement('path', {
      d: 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z',
    }),
  )
}

/**
 * 原生 dsh 播放/暂停图标（对齐 primitives IconPlayOutline16 / IconPauseOutline16，
 * 16px，颜色跟 currentColor）。暂停态显示播放（继续），运行态显示暂停。
 */
function playPauseIconEl(className, paused) {
  const paths = paused
    ? [
        // 播放（继续）：三角
        'M14.1446 8C14.1446 4.6062 11.3938 1.85539 8 1.85539C4.6062 1.85539 1.85539 4.6062 1.85539 8C1.85539 11.3938 4.6062 14.1446 8 14.1446C11.3938 14.1446 14.1446 11.3938 14.1446 8ZM15.511 8C15.511 12.148 12.148 15.511 8 15.511C3.85202 15.511 0.489014 12.148 0.489014 8C0.489014 3.85202 3.85202 0.489014 8 0.489014C12.148 0.489014 15.511 3.85202 15.511 8Z',
        'M10.5617 8.42578C10.852 8.21614 10.852 7.78386 10.5617 7.57422L7.25708 5.18751C6.90974 4.93666 6.42436 5.18484 6.42436 5.61329V10.3867C6.42436 10.8152 6.90974 11.0633 7.25708 10.8125L10.5617 8.42578Z',
      ]
    : [
        // 暂停：双竖条
        'M14.1448 8.00024C14.1448 4.60644 11.394 1.85563 8.00024 1.85563C4.60644 1.85563 1.85563 4.60644 1.85563 8.00024C1.85563 11.394 4.60644 14.1448 8.00024 14.1448C11.394 14.1448 14.1448 11.394 14.1448 8.00024ZM15.5112 8.00024C15.5112 12.1482 12.1482 15.5112 8.00024 15.5112C3.85226 15.5112 0.489258 12.1482 0.489258 8.00024C0.489258 3.85226 3.85226 0.489258 8.00024 0.489258C12.1482 0.489258 15.5112 3.85226 15.5112 8.00024Z',
        'M7.14244 5.14258V10.8569H5.71387V5.14258H7.14244Z',
        'M10.286 5.14258V10.8569H8.85742V5.14258H10.286Z',
      ]
  return React.createElement(
    'svg',
    {
      className, width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      'aria-hidden': 'true', style: { flex: 'none' },
    },
    paths.map((d, i) => React.createElement('path', { key: i, d, fill: 'currentColor' })),
  )
}
