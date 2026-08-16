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

/** 已精炼段的实际消耗标注：" · 精炼 ~N tok"（输入裁剪后 + 输出摘要）。 */
function refineTokStr(s) {
  if (!s || !s.refined) return ''
  const rt = s.refineTokens || {}
  const total = (rt.input || 0) + (rt.output || 0)
  return total > 0 ? ' · 精炼 ~' + fmtTok(total) + ' tok' : ''
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
