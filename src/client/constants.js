/**
 * 客户端常量（由 scripts/build-client.mjs 按序拼接打包为单 bundle，
 * 模块间共享同一作用域，无需 import）。
 */
const NS = 'think-summary'
const STATE_ROUTE = '/api/think-summary/state'
const SETTINGS_PREFIX = '/api/think-summary/settings'
const CLEAR_ARCHIVED_ROUTE = '/api/think-summary/clear-archived'
