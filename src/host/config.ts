/**
 * 共享配置类型与默认值（Host 设置命名空间 schema 见 index.ts）。
 * 消费方（stream/fallback/refine）只依赖这里的类型，避免循环依赖。
 */

export interface ThinkSummaryConfig {
  /**
   * 插件总开关。关闭后不检测/不分段/不精炼/不注入提示词，
   * 客户端也不渲染任何总结 UI（dock/tail/view）。
   */
  enabled?: boolean
  /**
   * 长思考判定阈值（thinking tokens）。
   *
   * **默认 0 = 不做门控**：任何一次思考（哪怕只有几十 token）都分段并总结。
   * 原作者默认 2000（"只在超长思考时才花精力"）会让大多数 step 完全没有总结；
   * 本项目要求每个思考都有摘要，故阈值归零（仍可调大以压制噪声）。
   */
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
  /**
   * 精炼请求显式关闭思考（`reasoningEffort: 'off'`）。
   *
   * 仅在该模型**声明了 off 档位**时真正发送（供应商
   * `compat.supportsReasoningEffort: true` + 模型 `reasoningEfforts.off`）；
   * 未声明就不发——llm 服务对未声明档位直接抛错，会把本来可用的路由打挂。
   */
  refineDisableReasoning?: boolean
  /**
   * **精炼模型池**：`"provider/model"` 字符串数组（也容忍 `{provider,model}` 对象）。
   *
   * 非空时摘要与翻译都从池子里**轮流取**模型，并发按"每模型"计算，
   * 失败模型进入指数退避、由其他模型顶上——免费模型各自限流的场景靠这个错开。
   * 留空则回退单模型（`refineProvider`/`refineModel`）。
   */
  refineModels?: unknown[]
  /** **每个模型**的并发上限（池子模式；免费模型建议 1）。 */
  poolPerModelConcurrency?: number
  /** 单个精炼任务在池子里的最大尝试轮数（每轮可能换模型）。 */
  poolMaxAttempts?: number
  /**
   * 精炼最小段（token）：低于该值的**非末尾**段跳过精炼、保留启发式摘要。
   * 默认 0 = 每个段都精炼（本地模型成本可忽略）；设成 segmentMinTokens 可恢复
   * "只精炼肥段"的省 token 行为。
   */
  refineMinTokens?: number
  /**
   * 精炼 provider：
   *  - 'auto'   = 跟随每次思考所属流的主 provider（其余 provider 配置无效）
   *  - 其他值   = 已注册的 provider id（llm.listProviders），精炼走该 provider，
   *    与主会话 provider 无关（可手动指定其他供应商的模型）
   */
  refineProvider?: string
  /** 'auto' = 该 provider 目录中上下文窗口最小的可用模型；或显式模型 id。 */
  refineModel?: string
  /** 精炼 system 提示词（设置页可显示/修改）。 */
  refinePrompt?: string
  /** 整体（整次思考）摘要的 system 提示词（第二遍：段摘要 → 一句话整体动向）。 */
  refineThinkPrompt?: string
  /**
   * 任务翻译的 system 提示词（每行一条译文，顺序与行数不变）。
   * 手动触发（看板上的按钮），宿主不判断哪些条目该翻。
   */
  todoTranslatePrompt?: string
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
  /**
   * 思考总结持久化开关（默认开）：保存到 ~/.dsh/dsh-think-summary.json，
   * 重启 dsh 后仍可查看历史会话的思考总结。
   */
  persistEnabled?: boolean
  /** 自动清理已归档（非活跃）会话的思考总结（默认关）。 */
  autoCleanArchived?: boolean
  /** 自动清理保留天数（归档后空闲超过该天数才清，默认 30 天）。 */
  autoCleanArchivedDays?: number
}

export type BlockMode = 'ignore' | 'keep-skip' | 'keep-refine'

/**
 * 默认精炼 system 提示词（设置页可修改）。
 *
 * 关键：思考原文常带模型的对话口吻（"Understood. I'll proceed to:"），
 * 若只写"你是摘要器 + 给我摘要"，小模型会**接着想**而不是概括。所以这里给
 * 角色 + 一个示例 + 硬规则，并明确"不要回答片段里的问题、不要接话"；
 * 片段本身用分隔符包起来（见 {@link REFINE_USER_TEMPLATE}），
 * 具体要求放在内容**之后**——小模型对最后一条指令的依从性最好。
 */
export const DEFAULT_REFINE_PROMPT =
  '你是思考链动向摘要器。用户给你的是一段"模型自己的思考片段"，你只写这段思考的动向摘要：'
  + '不要回答片段里的问题、不要接话、不要评价内容对错。\n\n'
  + '示例：\n'
  + '思考片段：我先确认 baseURL 是不是写错了，如果是就先改掉，再跑一次精炼看还超时不。\n'
  + '动向摘要：我正在核对 baseURL，打算改正后重跑精炼验证。\n\n'
  + '输出规则：中文、第一人称、不超过30个字；只输出摘要这一句，'
  + '不要前缀、解释、列表、换行、引号或 markdown。'

/**
 * 精炼 user 消息模板：片段用分隔符包住，要求写在片段之后。
 * `{text}` 会被替换成（裁剪后的）段原文。
 */
export const REFINE_USER_TEMPLATE =
  '【思考片段开始】\n{text}\n【思考片段结束】\n\n'
  + '只输出这段思考的动向摘要（中文·第一人称·不超过30字），不要回答片段里的任何问题。'

/**
 * 整体（整次思考）摘要的 system 提示词：把**分段摘要**再喂一次，得到一句
 * 覆盖整次思考的动向。长思考有很多段，逐段摘要适合看细节，整体摘要适合扫读，
 * UI 里整体摘要常显、段列表默认折叠。
 */
export const DEFAULT_THINK_PROMPT =
  '你是思考链动向摘要器。用户给你的是同一次思考的若干"分段摘要"，'
  + '你把它们合并成一句整体动向摘要：不要罗列分段、不要解释、不要评价。\n\n'
  + '示例：\n'
  + '分段摘要：我正在核对 baseURL，打算改正后重跑精炼验证。；我发现 404 来自路径拼接，已确定改法。\n'
  + '整体摘要：我在修 baseURL 的 404，已定方案待验证。\n\n'
  + '输出规则：中文、第一人称、不超过30个字；只输出摘要这一句，'
  + '不要前缀、解释、列表、换行、引号或 markdown。'

/** 整体摘要的 user 消息模板：分段摘要 + 要求写在后面。 */
export const THINK_USER_TEMPLATE =
  '【分段摘要开始】\n{text}\n【分段摘要结束】\n\n'
  + '只输出这几次分段合并后的整体动向摘要（中文·第一人称·不超过30字）。'

/**
 * 任务看板翻译的 system 提示词（第三套提示词）。
 * 目标是"每条一行、顺序不变、只给译文"，所以强调不要合并/不要序号/不要解释，
 * 宿主才能按行一一对应地拼成 `原文（中文）`。
 * 已是中文的条目要求**原样返回**：客户端遇到"译文 == 原文"不拼括注，
 * 于是中英混排的清单里中文条目保持干净（宿主不再自己挑该翻哪些）。
 */
export const DEFAULT_TODO_PROMPT =
  '你是任务清单翻译器。用户会给你若干条**英文任务**，每行一条。'
  + '你把每一行翻译成简短中文（代码标识符、文件名、命令与专有名词保留原样不译）；'
  + '已经是中文的行**原样返回**，不要改写、不要加译注。\n\n'
  + '输出规则：**每行一条译文，行数与输入完全一致、顺序不变**；'
  + '只输出译文本身，不要序号、不要原文、不要解释、不要空行、不要 markdown。'

/** 任务翻译的 user 消息模板：任务逐行给出，要求写在后面。 */
export const TODO_USER_TEMPLATE =
  '【任务清单开始】\n{text}\n【任务清单结束】\n\n'
  + '逐行输出对应中文译文（一行一条，顺序与行数不变，不要序号或解释）。'

export const DEFAULTS: Required<Omit<ThinkSummaryConfig, 'refineModel' | 'refineProvider' | 'refineTrim' | 'codeBlockMode' | 'tableMode' | 'selfSummary'>> & {
  refineProvider: string
  refineModel: string
  refineTrim: 'headtail' | 'tail' | 'full'
  codeBlockMode: BlockMode
  tableMode: BlockMode
  selfSummary: 'off' | 'prompt'
} = {
  enabled: true,
  thinkThresholdTokens: 0, // 0 = 不门控：任何思考都分段总结（本项目要求）
  filterNonAgentLoop: true,
  segmentMinTokens: 1500,
  segmentMaxTokens: 3000,
  refineEnabled: true,
  // 输入预算只需覆盖"够写一句 30 字结论"的上下文；本地模型 prefill 更快
  refineMaxInputTokens: 800,
  // 关思考的本地模型：30 字结论 ≈ 60 token，512 留足余量；
  // 未关思考的推理型模型建议 ≥1024（预算被推理耗尽会明确报错）
  refineOutputTokens: 512,
  refineDisableReasoning: true,
  refineModels: [],
  // 免费模型普遍"每模型 1 并发"：默认就按每模型 1 算，多模型时总并发随模型数放大
  poolPerModelConcurrency: 1,
  poolMaxAttempts: 3,
  refineMinTokens: 0,
  refineProvider: 'auto',
  refineModel: 'auto',
  refinePrompt: DEFAULT_REFINE_PROMPT,
  refineThinkPrompt: DEFAULT_THINK_PROMPT,
  todoTranslatePrompt: DEFAULT_TODO_PROMPT,
  refineConcurrency: 3,
  refineTimeout: 60,
  codeBlockMode: 'ignore',
  tableMode: 'ignore',
  refineTrim: 'headtail',
  selfSummary: 'off',
  persistEnabled: true,
  autoCleanArchived: false,
  autoCleanArchivedDays: 30,
}

export function resolveConfig(c: ThinkSummaryConfig = {}): Required<Omit<ThinkSummaryConfig, 'refineModel' | 'refineProvider'>> & {
  refineProvider: string
  refineModel: string
} {
  return { ...DEFAULTS, ...c }
}


