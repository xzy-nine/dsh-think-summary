/**
 * 任务看板（官方 `todo_write` / `todo/write`）的中文补充 —— **只影响渲染，不落日志**。
 *
 * 官方机制：`todo_write` 工具整表覆盖地 `session.append('todo/write', { todos })`，
 * 看板（`ui-conversation` 的 `TodoDock`）读的是该事件的会话投影。
 *
 * 三条被否掉的路：
 *  - **改写工具参数**：Host 工具管线明确禁止（`PreToolDecision` 只有 allow/deny/ask，
 *    注释写明 "Input rewriting is excluded because arguments are already logged and presented"）。
 *  - **追加一条带括注的 `todo/write`**：会改写会话状态——模型后续执行任务时读到的
 *    计划带着括注（用户明确否掉）。
 *  - **监听 `todo/write` 自动翻译**：无人要求时也烧模型（用户改为**手动触发**）。
 *
 * 采用的做法：**用户点按钮 → 宿主翻译 → 客户端拼接渲染**。
 *  1. 客户端把看板上还没有译文的条目原文 POST 过来（见 `client/todo.js`）；
 *  2. 宿主一次 LLM 调用批量翻译，按 `原文 → 译文` 存进**内存缓存**（不 append 任何事件）；
 *  3. 客户端把译文拼成 `原文（中文）` 后再渲染看板。
 *
 * 缓存与内容一一对应（与会话无关）：同一句原文在任何会话、任何页面刷新后都命中，
 * 重复点击不会再调模型。宿主不判断"哪些条目该翻"——请求里给什么就翻什么。
 */
import {
  resolveRefineRoute,
  collectStreamText,
  resolveOutputCap,
  clampOutputTokens,
  canDisableReasoning,
  type LlmLike,
  type RefineTask,
} from './summarize/refine.js'
import { DEFAULT_TODO_PROMPT, TODO_USER_TEMPLATE, type ThinkSummaryConfig } from './config.js'

/** 单次翻译的条目上限（防一次塞太多把本地小模型撑爆）。 */
export const MAX_TODO_ITEMS = 40
/** 单条原文长度上限（按字符截断，翻译输入保持可控）。 */
export const MAX_TODO_ITEM_CHARS = 400
/** 译文字符串上限（超长的当作模型跑偏，丢弃）。 */
const MAX_TRANSLATION_CHARS = 200
/** 内容缓存条数上限（FIFO 淘汰；本地模型的译文很小，够用很久）。 */
const MEMO_MAX = 500

/** 看板中文补充的宿主半面。 */
export interface TodoTranslator {
  /**
   * 翻译给定的条目原文（给什么翻什么，不判断该不该翻）。
   * @param contents - 条目原文列表；空串与重复项会被剔除，超出上限的截断。
   * @param sessionId - 仅用于日志与路由兜底。
   * @returns `原文 → 中文`；没有译文的条目不出现在结果里。
   */
  translate(contents: readonly unknown[], sessionId: string): Promise<Record<string, string>>
}

/**
 * 建任务看板翻译器（只缓存，不改会话状态，不监听任何事件）。
 * @param getOptions - 实时配置。
 * @param getLlm - llm 服务（可选）。
 * @param defaultModel - provider/model 兜底（无实时流上下文，用会话默认模型）。
 * @returns 供 RPC 调用的翻译器。
 */
export function createTodoTranslator(
  getOptions: () => ThinkSummaryConfig,
  getLlm: () => LlmLike | undefined,
  defaultModel: () => { provider: string; model: string },
): TodoTranslator {
  /** 原文 → 译文（与会话无关的内容缓存）。 */
  const memo = new Map<string, string>()

  return {
    async translate(contents: readonly unknown[], sessionId: string): Promise<Record<string, string>> {
      const targets = normalizeTargets(contents)
      if (targets.length === 0) return {}
      const result: Record<string, string> = {}
      const missing: string[] = []
      for (const content of targets) {
        const hit = memo.get(content)
        if (typeof hit === 'string' && hit.length > 0) result[content] = hit
        else missing.push(content)
      }
      if (missing.length === 0) return result // 全命中：不调模型
      try {
        const fresh = await translateBatch(getOptions(), getLlm, defaultModel, sessionId, missing)
        for (const [content, zh] of Object.entries(fresh)) {
          result[content] = zh
          remember(memo, content, zh)
        }
      } catch (error) {
        // 只记日志：翻译失败不该让按钮请求 500，客户端保持原文即可
        console.error('[dsh-think-summary] 任务看板翻译失败：', error instanceof Error ? error.message : error)
      }
      return result
    },
  }
}

/** 归一化请求条目：字符串、去空、去重、截断、限条数。 */
function normalizeTargets(contents: readonly unknown[]): string[] {
  if (!Array.isArray(contents)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of contents) {
    if (typeof raw !== 'string') continue
    const text = raw.slice(0, MAX_TODO_ITEM_CHARS)
    if (text.trim().length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= MAX_TODO_ITEMS) break
  }
  return out
}

/** 写缓存并按 FIFO 淘汰超限的最旧条目。 */
function remember(memo: Map<string, string>, content: string, zh: string): void {
  memo.set(content, zh)
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next()
    if (oldest.done === true) break
    memo.delete(oldest.value)
  }
}

/** 批量翻译：一次 LLM 调用，按行对应回各条目。 */
async function translateBatch(
  o: ThinkSummaryConfig,
  getLlm: () => LlmLike | undefined,
  defaultModel: () => { provider: string; model: string },
  sessionId: string,
  targets: readonly string[],
): Promise<Record<string, string>> {
  const llm = getLlm()
  if (!llm || typeof llm.stream !== 'function') return {}
  const fallback = defaultModel()
  const routeTask: RefineTask = {
    sessionId,
    thinkId: 'todo',
    segmentIndex: -1,
    text: '',
    provider: fallback.provider || 'unknown',
    fallbackModel: fallback.model,
  }
  const { route, error } = await resolveRefineRoute(llm, { provider: o.refineProvider, model: o.refineModel }, routeTask)
  if (!route.provider || !route.model) {
    console.error('[dsh-think-summary] 任务看板翻译跳过：', error ?? '精炼模型不可用')
    return {}
  }

  const input = targets.join('\n')
  // 与精炼同口径：maxTokens 必须先收敛到供应商合法区间（未收敛时 st 会直接 400
  // "field MaxTokens invalid"），关思考也只在该模型声明 off 档位时才发。
  const [cap, canOff] = await Promise.all([
    resolveOutputCap(llm, route.provider, route.model),
    o.refineDisableReasoning === true ? canDisableReasoning(llm, route.provider, route.model) : Promise.resolve(false),
  ])
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: clampOutputTokens(o.refineOutputTokens, cap),
    temperature: 0,
    ...canOff ? { reasoningEffort: 'off' } : {},
    system: o.todoTranslatePrompt ?? DEFAULT_TODO_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: TODO_USER_TEMPLATE.replace('{text}', input) }] }],
  })
  const raw = await collectStreamText(stream, `${route.provider}/${route.model}`)
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
  const map: Record<string, string> = {}
  targets.forEach((content, i) => {
    const zh = lines[i]
    if (typeof zh === 'string' && zh.length > 0 && zh.length <= MAX_TRANSLATION_CHARS) map[content] = zh
  })
  return map
}
