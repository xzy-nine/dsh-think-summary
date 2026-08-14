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
}

export const DEFAULTS: Required<Omit<ThinkSummaryConfig, 'refineModel'>> & { refineModel: string } = {
  enabled: true,
  thinkThresholdTokens: 2000,
  filterNonAgentLoop: true,
  segmentMinTokens: 1500,
  segmentMaxTokens: 3000,
  refineEnabled: true,
  refineMaxInputTokens: 1500,
  refineOutputTokens: 1024,
  refineModel: 'auto',
}

export function resolveConfig(c: ThinkSummaryConfig = {}): Required<Omit<ThinkSummaryConfig, 'refineModel'>> & { refineModel: string } {
  return { ...DEFAULTS, ...c }
}
