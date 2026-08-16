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

/** 段状态：主模型小结 → 小结标签；代码段/表格段 → 结构化摘要（未精炼）；未精炼原因 → 原因标签；已精炼 → 已精炼；否则无标签。 */
function segStatus(s) {
  if (s && s.kind === 'self') return { cls: 'ts-seg-self', label: '思考小结' }
  if (s && s.skipReason === 'code') return { cls: 'ts-seg-skip', label: '代码段·未精炼' }
  if (s && s.skipReason === 'table') return { cls: 'ts-seg-skip', label: '表格·未精炼' }
  if (s && s.refined) return { cls: 'ts-seg-refined', label: '已精炼' }
  if (s && s.unrefinedReason) return { cls: 'ts-seg-skip', label: s.unrefinedReason }
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

/** 段头标签：主模型小结 → "小结"；普通段 → "原始 X tok[ · 精炼 ~Y tok]"。 */
function segHeadLabel(s, prefix) {
  return prefix + '第' + (s.index + 1) + '段 · ' + (s.kind === 'self' ? '小结' : '原始 ' + fmtTok(s.tokens) + ' tok' + refineTokStr(s))
}
