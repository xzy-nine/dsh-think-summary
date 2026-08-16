/**
 * 主模型自产小结模式（docs/self-summary-mode.md）：
 *  - 通过 `system-prompt/assemble` waterfall 事件向系统提示词追加小结指令
 *    （每次组装都执行，不依赖 systemPrompt 服务的注册时机——修复此前
 *    section 注册可能因服务晚挂载而静默失败的问题）
 *  - 流内捕获【思考小结】标记（reasoning-delta 文本），直接 push 为段摘要
 *    （仅展示补充：不改变外部分段逻辑；模型未输出小结时外部切段照常）
 *
 * 默认关闭（'off'）——提示词会改变主模型思考方式，副作用需实测。
 */

/** 小结标记（全角中括号，代码/正文不易误用）。 */
export const SELF_MARK = '【思考小结】'

/** 小结内容上限（字符）：防超长失控。 */
export const SELF_MAX_CHARS = 240

/** 注入的系统提示词片段（固定短文本，一次写好）。 */
export const PROMPT_SELF_SUMMARY =
  '在思考过程中，每完成一个重要子问题或得出阶段性结论时，输出一句不超过80字的阶段性小结，格式：【思考小结】内容。除该格式外不要在其他地方使用"思考小结"字样。'

/**
 * 按配置注入提示词：监听 `system-prompt/assemble` waterfall，组装时追加
 * think-summary:self 段（order 200）。每次 assemble 都执行，且不依赖
 * systemPrompt 服务句柄——比 section 注册可靠。ctx.on 注册的监听随插件
 * 生命周期自动清理。
 */
export function installSelfSummaryPrompt(ctx: { on?: (name: string, listener: (...args: any[]) => unknown) => unknown }, getOptions: () => { selfSummary?: 'off' | 'prompt'; enabled?: boolean }): () => void {
  const onAssemble = async (
    assembly: { sections?: Array<{ name: string; order: number; text: string; complete?: boolean }> } | undefined,
    _context: unknown,
    next: (assembly: unknown) => Promise<unknown>,
  ) => {
    try {
      const opts = getOptions()
      if (opts.enabled === false) return next(assembly)
      if (opts.selfSummary === 'prompt' && assembly && Array.isArray(assembly.sections)) {
        if (!assembly.sections.some((s) => s && s.name === 'think-summary:self')) {
          assembly.sections.push({ name: 'think-summary:self', order: 200, text: PROMPT_SELF_SUMMARY })
        }
      }
    } catch {
      /* 注入失败不影响组装 */
    }
    return next(assembly)
  }
  try {
    ctx.on?.('system-prompt/assemble', onAssemble)
  } catch {
    /* 事件不可用则本模式失效（捕获器仍可用） */
  }
  return () => undefined
}

export interface SelfPush {
  (summary: string): void
}

/**
 * 流内捕获器（每个 think 一个）：喂入 reasoning-delta 文本，
 * 捕获【思考小结】标记后的内容，到 下一个标记 / 行尾 / 句末标点 / 240 字符
 * （最先者）为止作为一个小结交给 onSelf。
 * flush()：流结束时未闭合的残留丢弃（可能是半截）。
 */
export function makeSelfSummaryCapture(onSelf: SelfPush) {
  /** 当前未闭合小结的内容；null = 不在小结内。 */
  let buf: string | null = null

  /** 结束符：句末标点或行尾（小结是一句，模型通常独立一行输出）。 */
  const END_RE = /[。！？!?；;]|\n/

  const emit = (text: string) => {
    const s = text.trim()
    if (s.length > 0) onSelf(s.length > SELF_MAX_CHARS ? s.slice(0, SELF_MAX_CHARS) + '…' : s)
  }

  const feed = (text: string) => {
    if (!text) return
    let rest = text
    while (rest.length > 0) {
      if (buf === null) {
        const mark = rest.indexOf(SELF_MARK)
        if (mark < 0) return
        buf = ''
        rest = rest.slice(mark + SELF_MARK.length)
        continue
      }
      const mark = rest.indexOf(SELF_MARK)
      if (mark >= 0) {
        buf += rest.slice(0, mark)
        emit(buf)
        buf = null
        rest = rest.slice(mark + SELF_MARK.length)
        continue
      }
      const end = rest.search(END_RE)
      if (end >= 0) {
        buf += rest.slice(0, end + 1)
        emit(buf)
        buf = null
        rest = rest.slice(end + 1)
        continue
      }
      buf += rest
      if (buf.length > SELF_MAX_CHARS) {
        emit(buf)
        buf = null
      }
      return
    }
  }

  const flush = () => {
    buf = null // 未闭合小结丢弃
  }

  return { feed, flush }
}
