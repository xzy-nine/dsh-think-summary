/**
 * 共享配置类型与默认值（Host 设置命名空间 schema 见 index.ts）。
 * 消费方（stream/fallback/refine）只依赖这里的类型，避免循环依赖。
 */

export interface ThinkSummaryConfig {
  /** 总开关。 */
  enabled?: boolean
  /** 长思考判定阈值（thinking tokens）。 */
  thinkThresholdTokens?: number
  /** 是否只处理带 sessionId 的请求（过滤子代理/标题生成等旁路流）。 */
  filterNonAgentLoop?: boolean
  /** 段最小窗口（token），达到后可切（等语义边界）。 */
  segmentMinTokens?: number
  /** 段硬上限（token），到点强制切。 */
  segmentMaxTokens?: number
  /** 小模型精炼开关（开启即全量精炼，不做段大小门控）。 */
  refineEnabled?: boolean
  /** 精炼输入预算（token），只喂段尾部。 */
  refineMaxInputTokens?: number
  /** 精炼 API 完成预算（token），需覆盖推理+答案。 */
  refineOutputTokens?: number
  /** 'auto' = 会话 provider 的最小可用模型；或显式模型 id。 */
  refineModel?: string
  /** 精炼 system 提示词（设置页可显示/修改）。 */
  refinePrompt?: string
  /** 并行精炼数（并发执行，任务之间互不打断）。 */
  refineConcurrency?: number
  /** 单任务超时（秒）：卡死任务超时放弃并释放并发位。 */
  refineTimeout?: number
  /**
   * 代码块处理：'ignore' 内容不写进缓冲（省内存/token，仅记行数元信息段）；
   * 'keep-skip' 保留内容（原子不分段）+ 结构化摘要、跳过精炼；
   * 'keep-refine' 保留内容 + 精炼。
   */
  codeBlockMode?: 'ignore' | 'keep-skip' | 'keep-refine'
  /** 表格处理：同 codeBlockMode。 */
  tableMode?: 'ignore' | 'keep-skip' | 'keep-refine'
  /**
   * 精炼输入裁剪策略：
   *  - 'headtail' 头尾裁剪（保留头部主题+尾部结论、丢中段，同预算信息量更高，但中段细节丢失）
   *  - 'tail'     仅保尾部（中段细节完整，但主题/背景信息丢失）
   *  - 'full'     完整保留（不裁剪，信息最全，最耗 token）
   */
  refineTrim?: 'headtail' | 'tail' | 'full'
  /**
   * 主模型自产小结模式（docs/self-summary-mode.md）：
   *  - 'off' 关闭（默认，不注入提示词、不捕获）
   *  - 'prompt' 向系统提示词注入小结指令（order 200），流内捕获【思考小结】标记，
   *    直接作为段摘要展示（仅展示补充，不影响外部分段）
   */
  selfSummary?: 'off' | 'prompt'
}

export type BlockMode = 'ignore' | 'keep-skip' | 'keep-refine'

/** 默认精炼 system 提示词（设置页可修改）。 */
export const DEFAULT_REFINE_PROMPT =
  '你是思考链分段摘要器。用不超过60个字总结给定思考片段的核心内容与结论，只输出总结本身，不要任何前缀或解释。'

export const DEFAULTS: Required<Omit<ThinkSummaryConfig, 'refineModel' | 'refineTrim' | 'codeBlockMode' | 'tableMode' | 'selfSummary'>> & {
  refineModel: string
  refineTrim: 'headtail' | 'tail' | 'full'
  codeBlockMode: BlockMode
  tableMode: BlockMode
  selfSummary: 'off' | 'prompt'
} = {
  enabled: true,
  thinkThresholdTokens: 2000,
  filterNonAgentLoop: true,
  segmentMinTokens: 1500,
  segmentMaxTokens: 3000,
  refineEnabled: true,
  refineMaxInputTokens: 1500,
  refineOutputTokens: 1024,
  refineModel: 'auto',
  refinePrompt: DEFAULT_REFINE_PROMPT,
  refineConcurrency: 3,
  refineTimeout: 60,
  codeBlockMode: 'ignore',
  tableMode: 'ignore',
  refineTrim: 'headtail',
  selfSummary: 'off',
}

export function resolveConfig(c: ThinkSummaryConfig = {}): Required<Omit<ThinkSummaryConfig, 'refineModel'>> & { refineModel: string } {
  return { ...DEFAULTS, ...c }
}
