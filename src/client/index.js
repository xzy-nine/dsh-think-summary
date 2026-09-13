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
  // 每一步各自容错：任何一步失败只丢那一步，绝不让后面的注册（尤其 CSS 注入）被跳过。
  // （实测教训：对话内卡片那段用了不存在的 ctx.timeout，抛错被外层 catch 吞掉，
  //   后面 3/4/5 步全没执行 —— 设置卡片没样式、视图页与 dock 也消失。）
  const step = (label, run) => {
    try {
      run()
    } catch (error) {
      console.error('[dsh-think-summary] client apply step failed (' + label + '):', error)
    }
  }

  step('settings card', () => {
    // 1) 设置卡片（官方插件配置区，直连自建设置桥）。
    //    rc.7 起 settings.plugin.item 是 keyed 槽位：注册必须传 key（= 设置命名空间），
    //    旧的 id/order/label 写法会在声明时抛 keyed slot requires options.key。
    const scope = createBridgeScope()
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
      { name: 'settings.plugin.item', key: 'think-summary' },
      makeSettingsCard(scope),
    ))
  })
  step('step card', () => {
    // 2) 对话体内每步的总结卡：**委托官方 assistant-step**（官方内容照常渲染，
    //    卡片追加在其下方）。对话体内没有"思考行下方"的槽位，官方内联思考渲染在
    //    AssistantMarkdown 里，所以只能以同一 key 委托官方组件再追加。
    //    官方条目晚于本插件注册（实测：apply 期间 entries() 是 0 条、timer 未挂载、
    //    全局定时器不可用）→ 拿不到就挂一个空渲染的注册器到 input.dock，
    //    在它的 React effect 里轮询等待（effect 内全局定时器可用）。
    const registrar = installStepCardRegistrar(ctx, makeThinkStepCard)
    if (registrar !== null) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'think-summary.registrar', order: 0 },
        registrar,
      ))
    }
  })
  step('summary view', () => {
    // 3) "思考总结"视图选项卡：全会话思考总结（conversation.view 条目）
    ctx.slots.inject('conversation.view', () => ctx.slots.register(
      { name: 'conversation.view', id: 'think-summary', order: 20, label: '思考总结' },
      makeThinkSummaryView(),
    ))
  })
  step('todo dock', () => {
    // 4) 任务看板的中文补充：**只改渲染**——委托官方 TodoDock（id `'todo'`），
    //    只把 `useProjection('todos')` 的结果拼成 `原文（中文）`；会话日志零改动，
    //    不会影响模型后续执行任务时读到的计划。官方条目未就绪则挂空注册器等它。
    const registrar = installTodoDock(ctx)
    if (registrar !== null) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'think-summary.todo-registrar', order: 0 },
        registrar,
      ))
    }
  })
  // 5) 输入框上方的实时面板：**已按要求隐藏**（总结改到对话体内每步下方，
  //    面板与它重复）。保留 dock.js 源码以便随时恢复：重新加上下面这段即可。
  //    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
  //      { name: 'conversation.input.dock', id: 'think-summary.dock', order: 1 },
  //      makeInputDock(),
  //    ))
  step('styles', () => {
    // 6) 样式注入（放最后也最不能失败：设置卡/视图卡/每步卡片的布局都靠它）
    if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-thinksummary-css]')) {
      const style = document.createElement('style')
      style.dataset.dshThinksummaryCss = ''
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }
  })
}
