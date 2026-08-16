/**
 * DSH 宿主 ctx 的最小结构面（get/on + 服务查找）。
 * cordis 4 的 get/on 经 mixin 类型合并，独立导入 Context 时合并不生效，
 * 这里以结构类型显式声明，避免依赖类型合并细节。
 */
export interface CtxLike {
  get<T = unknown>(name: string): T | undefined
  on(name: string, listener: (...args: any[]) => unknown): unknown
  /** cordis effect：注册卸载清理器（插件停止/重载时执行）。 */
  effect?(disposer: () => void): void
}
