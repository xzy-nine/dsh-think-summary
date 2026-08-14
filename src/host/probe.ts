/**
 * 开发期探测工具：在真实 DSH 进程中重新验证 StreamChunk 形状 / thinking 块名 /
 * 会话归属。运行一次后把结论更新到 detect.ts 的 DEFAULT_CLASSIFIER 与
 * stream.ts 的归属/过滤逻辑，并记录到 probe-notes.md。
 *
 * 使用方式：作为临时动态插件加载（见会话内的 thkp-1 原型），或在本包内
 * 挂一个 debug 开关后观察 console 输出。
 */
export function probeChunkShape(chunk: unknown): void {
  // eslint-disable-next-line no-console
  console.log('[think-summary/probe]', JSON.stringify(chunk))
}
