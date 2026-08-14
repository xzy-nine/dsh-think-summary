/**
 * dsh-think-summary web client 入口。
 * 纯 JS（无 JSX/TS/import），由 scripts/build-client.mjs 与同目录模块
 * （constants/utils/styles/settings/tail/dock）按序拼接为单个 ModuleLoader bundle；
 * React 来自 bundle 包裹层的 `require("react")`。
 *
 * 失败策略：任何 DOM/网络异常只记录，绝不向上抛（web shell 会因插件 apply
 * 抛错而整个启动失败）。
 */

export const name = 'dsh-think-summary'

export const inject = ['slots']

export function apply(ctx) {
  try {
    // 1) 设置卡片（官方插件配置区，直连自建设置桥）
    const scope = createBridgeScope()
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
      { name: 'settings.plugin.item', id: 'think-summary', order: 120, label: 'think-summary' },
      makeSettingsCard(scope),
    ))
    // 2) 聊天流内：对应助手消息输出下方的思考总结条（可折叠/多行）
    //    select 返回值成为组件的 matched prop：传 TurnLocation 对象 + seq
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      {
        name: 'conversation.chat.turnTail',
        select: (owner) => (owner && owner.turn && typeof owner.turn.turn === 'number' ? { turn: owner.turn, seq: owner.seq } : null),
      },
      makeThinkTail(),
    ))
    // 3) 输入框上方实时面板（配合输入框样式；只显示当前思考）
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'think-summary.dock', order: 1 },
      makeInputDock(),
    ))
    // 4) 样式注入
    if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-thinksummary-css]')) {
      const style = document.createElement('style')
      style.dataset.dshThinksummaryCss = ''
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }
  } catch (error) {
    // web shell 会因 apply 抛错而启动失败：外部插件必须吞掉
    console.error('[dsh-think-summary] client apply failed:', error)
  }
}
