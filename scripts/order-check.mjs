/**
 * 客户端 bundle 顺序检查：`node scripts/order-check.mjs`
 *
 * build-client.mjs 按依赖序拼接模块（constants → utils → styles → settings →
 * step → dock → views → index），后序模块直接用前序模块的函数/常量。这里按
 * **出现位置递增** 验证拼接结果：step 的委托注册在 dock 之前、dock 在 views 之前、
 * index.js 的各作用域注册在所有模块之后。
 */
import { readFileSync } from 'node:fs'
const s = readFileSync('lib/client.js', 'utf8')
const keys = [
  'function installStepCardRegistrar',     // step.js
  "slots.inject('conversation.chat.node'", // step.js：委托 assistant-step 的注册
  'function makeThinkStepCard',            // step.js
  'function officialTodoDock',             // todo.js
  'function makeTodoTranslatedDock',        // todo.js
  'function installTodoDock',              // todo.js
  "slots.inject('conversation.input.dock'", // todo.js（接管看板）/ index.js（空注册器）
  'function isChatTabActive',              // dock.js
  'function makeInputDock',
  'function makeThinkSummaryView',         // views.js
  "slots.inject('settings.plugin.item'",   // index.js
  "slots.inject('conversation.view'",
]
const idx = keys.map((k) => s.indexOf(k))
console.log(idx.join(' < '))
const missing = keys.filter((k, i) => idx[i] < 0)
const ordered = idx.every((v, i, a) => i === 0 || v > a[i - 1])
if (missing.length > 0) console.log('缺少模块片段：' + missing.join(', ') + ' ✗')
else if (ordered) console.log('模块顺序正确 ✅')
else console.log('顺序错误 ✗')
process.exit(missing.length > 0 || !ordered ? 1 : 0)



