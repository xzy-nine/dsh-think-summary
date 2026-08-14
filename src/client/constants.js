/**
 * 客户端常量（由 scripts/build-client.mjs 按序拼接打包为单 bundle，
 * 模块间共享同一作用域，无需 import）。
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
