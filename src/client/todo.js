/**
 * 任务看板的中文补充 —— **只改渲染 + 一个手动按钮**。
 *
 * 官方看板是 `ui-conversation` 的 `TodoDock`，注册在 `conversation.input.dock`
 * 的 **id `'todo'`**（list 槽位：同 id 用**更低 priority** 注册即可遮蔽该条目，见
 * `TODO_PRIORITY`）。它内部用 `props.useProjection('todos')` 读取会话投影——
 * `useProjection` 是**从 props 拿的钩子**，所以可以：**委托官方组件渲染**，只把传给它的
 * `useProjection` 包一层，把 `'todos'` 的结果拼成 `原文（中文）`。
 * 官方内容/样式/交互一律不变，会话日志零改动。
 *
 * 翻译**由用户点按钮触发**：宿主不再监听 `todo/write`、也不判断"哪些条目该翻"，
 * 请求里给什么就翻什么（见 `host/todo.ts`）。所以这里没有轮询、没有自动请求——
 * 只有点击时发一次 POST，把返回的 `原文 → 译文` 并进本页面的展示表。
 */

/** 官方任务看板在该槽位里的 id（复用同一个 id 即替换它）。 */
const TODO_DOCK_ID = 'todo'

/** 本插件在槽位里的 registrant。 */
const TODO_REGISTRANT = 'dsh-think-summary'

/**
 * 接管 `'todo'` 这一格用的优先级。
 *
 * **list 槽位与 keyed 槽位同一条规则**：同一个 id 用**相同 priority** 注册会被拒绝——
 * 实测报错 `list slot "conversation.input.dock" already has an entry with id "todo"
 * at priority 0 (registered by conversation-todo-dock) — register at a different
 * priority to shadow it (lowest renders)`。必须换一个优先级来遮蔽，且**越低越优先渲染**。
 */
const TODO_PRIORITY = -1000

/** 按钮的四种文案（手动触发，文案本身就是全部交互说明）。 */
const TODO_BTN_IDLE = '翻译为中文'
const TODO_BTN_BUSY = '翻译中…'
const TODO_BTN_DONE = '已翻译'
const TODO_BTN_FAIL = '翻译失败，点击重试'

/** 取官方 todo dock 条目（component + locale，locale 决定官方拿到的 t）。 */
function officialTodoDock(slots) {
  try {
    if (slots === undefined || typeof slots.entries !== 'function') return undefined
    const all = slots.entries('conversation.input.dock') || []
    const hit = all.find((e) =>
      e !== undefined && e.options !== undefined && e.options.id === TODO_DOCK_ID
      && e.registrant !== TODO_REGISTRANT && e.component !== undefined)
    if (hit === undefined) return undefined
    return { component: hit.component, locale: hit.locale }
  } catch {
    return undefined
  }
}

/** 把译文拼成 `原文（中文）`；译文为空或与原文相同时保持原样（中文条目因此保持干净）。 */
function composeTranslated(content, zh) {
  const text = typeof zh === 'string' ? zh.trim() : ''
  if (text.length === 0 || text === content) return content
  return content + '（' + text + '）'
}

/** 从 todos 投影里取出非空原文（顺序即看板顺序）。 */
function todoContents(todos) {
  if (!Array.isArray(todos)) return []
  const out = []
  for (const item of todos) {
    const content = item && typeof item.content === 'string' ? item.content : ''
    if (content.length > 0) out.push(content)
  }
  return out
}

/**
 * 造出「委托官方 TodoDock + 只改写 todos + 追加翻译按钮」的组件。
 * @param official - 官方 TodoDock 的 component。
 * @returns 注册到 `conversation.input.dock` id `'todo'` 的组件。
 */
function makeTodoTranslatedDock(official) {
  return function TodoTranslatedDock(props) {
    // 自己订阅一次：拿条目原文，用于算"还差哪些译文"和决定按钮是否显示
    const todos = props.useProjection('todos')
    const [map, setMap] = React.useState({})
    const [busy, setBusy] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const contents = todoContents(todos)
    const pending = contents.filter((c) => typeof map[c] !== 'string' || map[c].length === 0)
    const sessionId = props.sessionId

    const onTranslate = () => {
      if (busy || pending.length === 0) return
      setBusy(true)
      setFailed(false)
      const run = async () => {
        try {
          const res = await fetch(TODO_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId || '', contents: pending }),
          })
          const json = res.ok ? await res.json() : null
          if (json && json.ok === true && json.translations) {
            setMap((prev) => Object.assign({}, prev, json.translations))
          } else {
            setFailed(true)
          }
        } catch (error) {
          console.warn('[dsh-think-summary] 任务看板翻译请求失败：', error)
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }
      void run()
    }

    // 委托官方渲染：只把 'todos' 的返回值拼上中文括注，其它 key 原样透传
    const useProjectionTranslated = (key, selector, equals) => {
      const value = props.useProjection(key, selector, equals)
      if (key !== 'todos' || !Array.isArray(value)) return value
      return value.map((item) => {
        const original = item && typeof item.content === 'string' ? item.content : undefined
        if (original === undefined) return item
        const zh = map[original]
        return typeof zh === 'string' && zh.length > 0
          ? Object.assign({}, item, { content: composeTranslated(original, zh) })
          : item
      })
    }

    // 按钮做成官方卡片的页脚行：外层 .ts-todo-wrap 画卡框（外框/圆角/底色），
    // 官方面板只留内容（边框由 CSS 去掉），按钮贴底——视觉上是同一张卡。
    const panel = React.createElement(official, Object.assign({}, props, { useProjection: useProjectionTranslated }))
    if (contents.length === 0) return panel // 无待办：官方渲染 null，不能留空卡框
    return React.createElement(
      'div',
      { className: 'ts-todo-wrap' },
      panel,
      React.createElement('button', {
        type: 'button',
        className: 'ts-todo-btn' + (busy ? ' ts-todo-btn--busy' : ''),
        onClick: onTranslate,
        disabled: busy || pending.length === 0,
        title: '把任务条目补上中文，原文保留；点一次翻一次，不自动翻译',
      }, busy ? TODO_BTN_BUSY : failed ? TODO_BTN_FAIL : pending.length === 0 ? TODO_BTN_DONE : TODO_BTN_IDLE),
    )
  }
}

/**
 * 安装任务看板的翻译渲染：接管 `conversation.input.dock` 的 `'todo'` 条目。
 *
 * 与步骤卡同样的时机问题（apply 期间官方条目还没注册、timer 未挂载、全局定时器不可用）：
 * 先试一次；不成就挂一个空渲染的注册器到同一个槽位，在它的 React effect 里轮询等待，
 * 拿到官方条目（含 locale）后完成接管。
 * @param ctx - 客户端插件 ctx。
 * @returns 需要挂载的注册器组件；已注册成功时返回 null。
 */
function installTodoDock(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return null
  let done = false

  const ensure = () => {
    if (done) return true
    const entry = officialTodoDock(slots)
    if (entry === undefined) return false
    // 必须换优先级：同 id 同 priority 会被 list 槽位拒绝
    const options = { name: 'conversation.input.dock', id: TODO_DOCK_ID, order: 0, priority: TODO_PRIORITY }
    if (typeof entry.locale === 'string' && entry.locale.length > 0) options.locale = entry.locale
    try {
      slots.register(options, makeTodoTranslatedDock(entry.component))
    } catch (err) {
      // 注册失败只放弃看板这一项，绝不让异常冒泡（否则注册器条目会连带失效）
      console.warn('[dsh-think-summary] 任务看板接管失败，跳过中文补充：', err)
      done = true
      return true
    }
    done = true
    return true
  }

  slots.inject('conversation.input.dock', () => { ensure(); return () => {} })
  if (ensure()) return null

  return function TodoDockRegistrar() {
    React.useEffect(() => {
      if (ensure()) return undefined
      let tries = 0
      const id = setInterval(() => {
        tries++
        if (ensure()) {
          clearInterval(id)
          return
        }
        if (tries > 150) {
          clearInterval(id)
          console.warn('[dsh-think-summary] 未找到官方 todo 看板条目，跳过看板中文补充')
        }
      }, 200)
      return () => clearInterval(id)
    }, [])
    return null
  }
}
