/**
 * 客户端 bundle 构建：把纯 JS 客户端包成 DSH web 模块格式
 * （window.__ModuleLoader__.load({ id, factory })），输出到 lib/client.js。
 * 与 dsh-web-ui 生态的 tsdown 产物同构，但零依赖、可复现。
 *
 * 变换：剥离源码里的 ESM `export` 关键字，追加 `exports.x = x` 显式导出；
 * 提供 `React` 自由变量（require("react")）供源码使用。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 剥离 ESM export（源码只用 export const/function 与可选 export {}）
let body = src
  .replace(/^export\s+(const|function|let|var)\s+/gm, '$1 ')
  .replace(/^export\s+\{\s*([^}]+)\s*\}\s*;?/gm, '')

// 收集显式导出名
const exportsLines = []
for (const m of src.matchAll(/^export\s+(?:const|function|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
  exportsLines.push(`    exports.${m[1]} = ${m[1]};`)
}

const banner = `/**
 * dsh-think-summary web client (built by scripts/build-client.mjs).
 * ModuleLoader bundle: id = package name; factory receives the web runtime's
 * require for peer modules (react, @deepseek-ai/dsh-client-*).
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
`
const footer = `
    ${exportsLines.join('\n')}
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
`

const out = banner + body + footer
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), out)
console.log('[dsh-think-summary] wrote lib/client.js (%d bytes, exports: %s)', out.length, exportsLines.length > 0 ? exportsLines.map((l) => l.trim().replace('exports.', '')).join(', ') : '(none)')
