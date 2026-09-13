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
  /** cordis 依赖回调：服务出现时执行，插件卸载时自动回收（可选服务用）。 */
  inject?(deps: string[], callback: (ctx: unknown) => unknown): unknown
}

/**
 * settings 服务的最小结构面（`@deepseek-ai/dsh-settings` 的 SettingsProvider）。
 * 插件不 import 该包：外部 profile 的行只解析包自身与 $DSH_HOME 的 node_modules，
 * `@deepseek-ai/dsh-*` 在运行时不可解析；服务经 ctx 取用即可（0.1.5 起
 * installSection 是服务方法，不再有顶层 installSettingsSection/settingsNamespace 导出）。
 */
export interface SettingsSectionHooksLike<T> {
  /** 接收当前权威配置源（设置作用域，或未挂载时的组合 entry）。 */
  setSource(current: () => T): void
  /** attach/detach/提交变更后重新判断派生事实。 */
  onChange(): void
}

export interface SettingsServiceLike {
  readonly writable: boolean
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: SettingsSectionHooksLike<unknown>,
  ): void
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: unknown
    value?: unknown
    base?: unknown
    user?: unknown
    revision?: number
  }>
  get(ns: string): unknown
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<unknown>
}
