/**
 * 客户端 bundle 开发 watch：监听 src/client/ 变化，自动重跑 scripts/build-client.mjs。
 *
 * 宿主每请求实时读取 lib/client.js（见 docs/probe-notes.md §6.5），
 * 因此本脚本重建后【刷新浏览器】即生效，无需重启 dsh。
 * Host 半面（src/host/*.ts）改动仍需 `npm run build` + 重启 dsh。
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'src', 'client')

let building = false
let pending = false

function rebuild() {
  if (building) {
    pending = true
    return
  }
  building = true
  const child = spawn(process.execPath, [join(root, 'scripts', 'build-client.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    building = false
    console.log(`[watch-client] build ${code === 0 ? 'ok' : 'FAILED (exit ' + code + ')'} @ ${new Date().toLocaleTimeString()}`)
    if (pending) {
      pending = false
      rebuild()
    }
  })
}

console.log(`[watch-client] watching ${clientDir} ...`)
watch(clientDir, { persistent: true }, (_event, filename) => {
  if (filename && filename.endsWith('.js')) {
    console.log(`[watch-client] change: ${filename}`)
    rebuild()
  }
})
