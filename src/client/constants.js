/**
 * 客户端常量（由 scripts/build-client.mjs 按序拼接打包为单 bundle，
 * 模块间共享同一作用域，无需 import）。
 */
const NS = 'think-summary'
const STATE_ROUTE = '/api/think-summary/state'
const SETTINGS_PREFIX = '/api/think-summary/settings'
const CLEAR_ARCHIVED_ROUTE = '/api/think-summary/clear-archived'

/** 主题变量（对齐原生 dsh 设计令牌，带降级）。 */
const T = {
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
  bg: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.07))',
  text: 'var(--dsw-alias-label-primary, inherit)',
  dim: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.85))',
  accent: 'var(--dsw-alias-state-business-primary, #4a9eff)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))',
  ok: 'var(--dsw-alias-state-success-primary, #34c759)',
  err: 'var(--dsw-alias-state-error-primary, #ff5f57)',
  warn: 'var(--dsw-alias-state-warn-primary, #ffd60a)',
  badge: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,.12))',
}
