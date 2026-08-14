/**
 * DSH 宿主事件类型增强：`llm/stream` / `session/event` 由 dsh 宿主声明，
 * 不在 @deepseek-ai/cordis 基础 Events 表内；这里以宽松类型补上，
 * 使 ctx.on 在这些事件上获得参数推断。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream': [options: unknown, next: () => AsyncIterable<unknown>]
    'session/event': [session: unknown, event: unknown]
  }
}
