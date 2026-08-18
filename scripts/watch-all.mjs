/**
 * 全量开发 watch：并行跑 tsc --watch（Host 半面 → lib/）与客户端 bundle watch
 * （src/client/ → lib/client.js）。
 *
 * 用法：npm run watch:all
 *  - Host 半面改动：tsc 编译到 lib/ 后【重启 dsh】生效；
 *  - 客户端改动：bundle 重建后【刷新浏览器】即生效。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('exit', (code) => {
    console.error(`[watch-all] ${label} exited with code ${code}`)
  })
  return child
}

const isWin = process.platform === 'win32'
const children = [
  run('tsc --watch', isWin ? 'npx' : 'tsc', ['tsc', '-p', 'tsconfig.json', '--watch']),
  run('watch-client', process.execPath, [join(root, 'scripts', 'watch-client.mjs')]),
]

process.on('SIGINT', () => {
  for (const child of children) child.kill('SIGINT')
  process.exit(0)
})
