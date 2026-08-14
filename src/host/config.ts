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
  /** 跳过代码段精炼（纯代码段用结构化摘要，省 token）。 */
  refineSkipCode?: boolean
  /**
   * 精炼输入裁剪策略：
   *  - 'headtail' 头尾裁剪（保留头部主题+尾部结论、丢中段，同预算信息量更高，但中段细节丢失）
   *  - 'tail'     仅保尾部（中段细节完整，但主题/背景信息丢失）
   *  - 'full'     完整保留（不裁剪，信息最全，最耗 token）
   */
  refineTrim?: 'headtail' | 'tail' | 'full'
}

export const DEFAULTS: Required<Omit<ThinkSummaryConfig, 'refineModel' | 'refineTrim'>> & {
  refineModel: string
  refineTrim: 'headtail' | 'tail' | 'full'
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
  refineSkipCode: true,
  refineTrim: 'headtail',
}

export function resolveConfig(c: ThinkSummaryConfig = {}): Required<Omit<ThinkSummaryConfig, 'refineModel'>> & { refineModel: string } {
  return { ...DEFAULTS, ...c }
}
