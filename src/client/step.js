/**
 * 对话体内「每步思考总结卡」——**委托官方 `assistant-step` 渲染**。
 *
 * 为什么是委托：DSH 的聊天里，内联思考行（`ReasoningRow`）与正文都在
 * `assistant-step` 节点内部（`AssistantMarkdown`），没有任何"思考行下方"的槽位；
 * 而 `turn-process` 节点在当前布局下根本不渲染（实测：无条件渲染的探针卡也没出现），
 * `turnTail`/`assistant-actions` 都在回合末尾且要等回合结束。
 *
 * 所以做法是：**先取官方条目**（`slots.entries('conversation.chat.node')` 里
 * `key === 'assistant-step'`、registrant 不是本插件的那条），拿到它的 component 与
 * `locale`（后者决定官方拿到的本地化函数 `t`，缺了会在 markdown 标签处抛错），
 * 再以同一个 key 注册本插件条目：渲染官方组件（内容与行为完全不变）+ 在其下方追加
 * 当步的总结卡。拿不到官方组件时**不注册**，自动退回"只有输入框上方面板"的现状。
 *
 * 数据：按 `think.turn + think.step` 精确匹配当前步；轮询沿用 useThinkState。
 */

/** 本插件在槽位里的 registrant（用于把官方条目自己排除掉）。 */
const STEP_REGISTRANT = 'dsh-think-summary'

/**
 * 接管 `assistant-step` 用的优先级。
 *
 * keyed 槽位**不允许同优先级注册**（会抛 `already has an entry for key … at priority 0`），
 * 必须用一个**不同的** priority 来遮蔽；规则是**越低越优先渲染**，所以取一个明显更低的
 * 值——官方是 0，动态插件由框架自动分到 -7 左右，这里再低一档避免撞车。
 */
const STEP_PRIORITY = -1000

/**
 * 取官方 assistant-step 条目（component + locale）。
 *
 * 官方条目在本插件接管后仍留在 `entries()` 里（只是 `active: false`），所以可以
 * 在任意时刻解析；`locale` 必须原样带上，否则官方组件拿不到 `t`。
 * @param slots - 客户端 slots 服务。
 * @returns 官方条目信息；未就绪或不可用返回 undefined。
 */
function officialStepEntry(slots) {
  try {
    if (slots === undefined || typeof slots.entries !== 'function') return undefined
    const all = slots.entries('conversation.chat.node') || []
    const hit = all.find((e) =>
      e !== undefined && e.options !== undefined && e.options.key === 'assistant-step'
      && e.registrant !== STEP_REGISTRANT && e.component !== undefined)
    if (hit === undefined) return undefined
    return { component: hit.component, locale: hit.locale }
  } catch {
    return undefined
  }
}

/**
 * 诊断信息：注册失败时打进 console，一次就能看出失败在哪一环
 * （entries 不可用 / 条数为 0 / 有条目但没有 assistant-step）。
 * @param slots - 客户端 slots 服务。
 * @returns 一行可读诊断。
 */
function describeEntries(slots) {
  try {
    if (typeof slots.entries !== 'function') return 'entries() 不可用'
    const all = slots.entries('conversation.chat.node') || []
    const keys = all.map((e) => (e && e.options && e.options.key) || '?').join(',')
    return 'entries() ' + all.length + ' 条 [' + keys + ']'
  } catch (error) {
    return 'entries() 报错：' + String((error && error.message) || error)
  }
}

/**
 * 安装「委托 assistant-step」的注册器。
 *
 * 时机问题（实测日志）：插件 `apply` 期间
 *  - `slots.entries('conversation.chat.node')` 返回 **0 条** —— 槽位刚声明，官方那批
 *    渲染器还没注册；
 *  - `ctx.get('timer')` 是 undefined —— timer 服务也还没挂载；
 *  - **浏览器全局定时器不可用**（`setTimeout` 会抛错，抛在 apply 里会连累后续步骤）。
 *
 * 唯一可靠的位置是 **React effect**（dock 的 `setInterval` 就是在 effect 里跑的）：
 * 因此在槽位声明时先试一次，未成功就返回一个**空渲染的注册器组件**，由 index.js
 * 挂到 input.dock 上，在其 effect 里轮询等待官方条目，找到后立即注册。
 *
 * @param ctx - 客户端插件 ctx。
 * @param makeCard - 传入官方 component，返回卡片组件。
 * @returns 需要挂载的注册器组件；若已注册成功则返回 null。
 */
function installStepCardRegistrar(ctx, makeCard) {
  const slots = ctx.get('slots')
  if (slots === undefined) return null
  let done = false

  /** 幂等注册：官方条目就绪就接管该 key（带上它的 locale 与更低优先级），返回是否已完成。 */
  const ensure = () => {
    if (done) return true
    const entry = officialStepEntry(slots)
    if (entry === undefined) return false
    // priority 必须与官方不同（更小 = 更优先渲染），否则 keyed 槽位会拒绝注册
    const options = { name: 'conversation.chat.node', key: 'assistant-step', priority: STEP_PRIORITY }
    if (typeof entry.locale === 'string' && entry.locale.length > 0) options.locale = entry.locale
    slots.register(options, makeCard(entry.component))
    done = true
    return true
  }

  // 槽位声明时先试一次（某些加载顺序下官方已注册）
  slots.inject('conversation.chat.node', () => { ensure(); return () => {} })
  if (ensure()) return null

  /** 空渲染的注册器：在 effect 里轮询等官方条目（全局定时器在 effect 内可用）。 */
  return function StepCardRegistrar() {
    React.useEffect(() => {
      if (ensure()) return undefined
      let tries = 0
      const id = setInterval(() => {
        tries++
        if (ensure()) {
          clearInterval(id)
          return
        }
        if (tries > 150) { // ~30s 窗口
          clearInterval(id)
          console.warn('[dsh-think-summary] 未找到官方 assistant-step，跳过对话内总结卡（仅保留输入框上方面板）· ' + describeEntries(slots))
        }
      }, 200)
      return () => clearInterval(id)
    }, [])
    return null
  }
}

/** 最小错误边界：官方渲染异常时只显示一张提示卡，不让整个聊天节点崩掉。 */
function makeErrorBoundary() {
  if (typeof React.Component !== 'function') return null
  return class ThinkStepBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { err: null }
    }

    static getDerivedStateFromError(error) {
      return { err: String((error && error.message) || error) }
    }

    render() {
      if (this.state.err !== null) {
        return React.createElement('div', { className: 'ts-proc-seg', style: { color: '#e5484d' } },
          '思考总结：官方步骤渲染失败（' + this.state.err + '）')
      }
      return this.props.children
    }
  }
}

/**
 * 造出「委托 assistant-step + 追加当步总结卡」的组件。
 * @param official - 官方 assistant-step 的 component。
 * @returns 注册到 `conversation.chat.node` 的 key `assistant-step` 的组件。
 */
function makeThinkStepCard(official) {
  const Boundary = makeErrorBoundary()
  return function ThinkStepCard(props) {
    const { state, enabled } = useThinkState(props && props.sessionId)
    // 展开状态：默认跟随"是否最新一次思考"——最新的展开，更早的自动折叠；
    // 用户点过之后以手动选择为准（manual !== null）。
    const [manual, setManual] = React.useState(null)
    const [busy, setBusy] = React.useState({})
    const [msg, setMsg] = React.useState('')

    const data = (props && props.node && props.node.data) || {}
    const turn = data.turn
    const step = data.step
    // 该步 assistant 消息 id（官方 finalNode 上带）：最精确的身份
    const messageId = data.finalNode && typeof data.finalNode.messageId === 'string'
      ? data.finalNode.messageId
      : undefined

    // 当步的 think：精确匹配优先（messageId → turn+step）。
    // **流式期间**这两者都还没有（会话格式 v3 没有 assistant/chunk，turn/step/messageId
    // 要等该步的 assistant/message 才打上），此时退化为"当前活跃的那条思考"——同一时刻
    // 只有一步在流式，所以不会串台；这样分段一精炼完卡片就出现，不必等该步结束、
    // 更不必等整体摘要（用户要求）。
    // 注意仍然**不做**"该 turn 唯一有段的 think"这种兜底：那会让每个 step 都命中同一条，
    // 同一张卡重复显示（实测踩过）。
    const withSegments = state && Array.isArray(state.thinks)
      ? state.thinks.filter((t) => t.segments && t.segments.length > 0)
      : []
    let think
    if (messageId !== undefined) think = withSegments.find((t) => t.messageId === messageId)
    if (think === undefined && typeof turn === 'number') {
      think = withSegments.find((t) => t.turn === turn && t.step === step)
    }
    if (think === undefined) {
      // 流式中的那一条：state 里唯一 active 的 think（同一时刻只有一步在跑）。
      // 不额外判 data.status——步骤结束到 assistant/message 打标之间有短暂空窗，
      // 只按 active 判定可以避免卡片闪一下消失。
      think = withSegments.find((t) => t.active === true)
    }
    // 折叠窗口：**最近 2 张卡展开**，更早的自动折叠——第 3 张出现时第 1 张收起，
    // 依次循环（用户要求）。点过之后以手动选择为准。
    const selfIndex = withSegments.indexOf(think)
    const fromEnd = selfIndex < 0 ? 0 : withSegments.length - 1 - selfIndex
    const autoOpen = fromEnd < 2

    const officialEl = React.createElement(official, props)
    const wrapped = Boundary === null ? officialEl : React.createElement(Boundary, null, officialEl)

    if (!enabled || think === undefined) return wrapped // 无当步总结：只渲染官方内容

    const segments = think.segments
    // 展开状态：手动优先，否则按"最近 2 张展开"的滚动窗口
    const open = manual === null ? autoOpen : manual
    // 第一行常显：整体摘要（第二遍）。还没生成时用最后一段摘要占位（流式期间也有内容看）。
    const headline = think.summary
      || (segments.length > 0 ? segments[segments.length - 1].summary : '')
    const headlineNote = think.summary ? '' : (think.summaryReason ? '整体摘要失败' : '整体摘要生成中…')

    const retry = async (index) => {
      const key = think.id + ':' + index
      setBusy((m) => ({ ...m, [key]: true }))
      setMsg('')
      try {
        const res = await fetch(REFINE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: props.sessionId, thinkId: think.id, segmentIndex: index }),
        })
        const json = await res.json()
        if (!json || json.ok !== true) setMsg('重试失败：' + String((json && json.message) || '未知错误'))
        else if (json.queued === 0 && json.refused > 0) setMsg('该段无原文（旧记录），无法重试')
        else if (json.queued === 0) setMsg('没有可重试的段')
      } catch (e) {
        setMsg('重试失败：' + String((e && e.message) || e))
      } finally {
        setTimeout(() => setBusy((m) => { const n = { ...m }; delete n[key]; return n }), 3000)
      }
    }

    const segEls = segments.map((s) => {
      const key = think.id + ':' + s.index
      const needsRetry = !s.refined && !s.skipReason && s.kind !== 'self'
      const isBusy = busy[key] === true
      // 一行一条：只给摘要文本（可截断、悬停看全文），未精炼的淡一档并悬停显示原因，
      // 「再试」按钮默认隐藏、悬停该行才出现——保持"流式过程"的干净观感。
      const dim = !s.refined
      const title = (s.unrefinedReason ? s.unrefinedReason + '\n' : '') + s.summary
      return React.createElement(
        'div', { key, className: 'ts-proc-line', 'data-dim': dim ? 'true' : 'false' },
        React.createElement('span', { className: 'ts-proc-line-text', title }, s.summary),
        needsRetry
          ? React.createElement('button', {
            type: 'button', className: 'ts-view-retry ts-proc-line-retry',
            disabled: isBusy || s.retryable !== true,
            title: s.retryable === true ? '用段原文重新精炼这一段' : '该段没有原文（0.1.4 之前的记录），无法重试',
            onClick: () => void retry(s.index),
          }, isBusy ? '重试中…' : '再试')
          : null,
      )
    })

    const card = React.createElement(
      'div', { className: 'ts-proc-card', 'data-open': open ? 'true' : 'false' },
      React.createElement(
        'button', {
          type: 'button', className: 'ts-proc-head',
          'aria-expanded': open,
          onClick: () => setManual(!open),
        },
        chevronEl('ts-proc-card-chevron'),
        // 第一行：整体摘要（加粗常显，类似思考链的"结论先行"）
        React.createElement('span', { className: 'ts-proc-headline' }, headline),
        headlineNote !== '' ? React.createElement('span', { className: 'ts-proc-meta' }, headlineNote) : null,
      ),
      open ? React.createElement('div', { className: 'ts-proc-body' }, ...segEls) : null,
      msg ? React.createElement('div', { className: 'ts-view-msg' }, msg) : null,
    )

    /**
     * 位置：卡片插在**本步的思考行之后、正文之前**。
     * 官方把思考行与正文都渲染在同一个 `AssistantMarkdown` 里，没有中间槽位，
     * 于是把该步的内容块拆两半、**用官方渲染器分别渲染**（绝不自己实现 markdown），
     * 卡片夹在中间。没有 reasoning 块时退回"官方内容 + 卡片在后"。
     */
    const blocks = Array.isArray(data.blocks) ? data.blocks : null
    const renderOfficial = (blockList) => {
      const el = React.createElement(official, {
        ...props,
        node: { ...props.node, data: { ...data, blocks: blockList } },
      })
      return Boundary === null ? el : React.createElement(Boundary, null, el)
    }
    if (blocks !== null && blocks.some((b) => b && b.kind === 'reasoning')) {
      const reasoningBlocks = blocks.filter((b) => b && b.kind === 'reasoning')
      const answerBlocks = blocks.filter((b) => !b || b.kind !== 'reasoning')
      return React.createElement(
        React.Fragment, null,
        renderOfficial(reasoningBlocks),
        card,
        answerBlocks.length > 0 ? renderOfficial(answerBlocks) : null,
      )
    }
    return React.createElement(React.Fragment, null, wrapped, card)
  }
}
