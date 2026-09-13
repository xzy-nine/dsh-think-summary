/**
 * 精炼队列回归检查：`node scripts/refine-check.mjs`
 *
 * 覆盖三类容易静默出错的行为（都实机踩过）：
 *  1. provider 侧失败（终态 finish{kind:'error'|'aborted'}）与“无文本”必须写回
 *     段的未精炼原因——旧版只累计 text-delta，失败被吞掉，UI 永远停在“待精炼”。
 *  2. provider/model 解析：auto 跟随主请求、显式供应商可跨供应商、
 *     未注册供应商回退、目录不可用时旧宿主仍能回退到主模型。
 *  3. 摘要归一化：模型回小作文时只取第一句（否则长回复会被原样存下并标“已精炼”）。
 *
 * 依赖已构建的 lib/（先跑 `npm run build`）。
 */
import { RefineQueue, resolveRefineRoute, listProviderIds, normalizeSummary, resolveOutputCap, clampOutputTokens, canDisableReasoning } from '../lib/host/summarize/refine.js'
import { decideRefine } from '../lib/host/summarize/pipeline.js'
import { createTodoTranslator } from '../lib/host/todo.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${e}\n       actual   ${a}`}`)
}

/** 回放给定 chunk 序列的假 llm（模拟宿主 llm.stream 的终态语义）。 */
const replay = (chunks) => ({ stream: () => (async function* () { for (const c of chunks) yield c })() })

/** 跑一个精炼任务，返回首个结果（applied 或 failed）。 */
async function refineOnce(chunks, options = {}) {
  const results = []
  const q = new RefineQueue(
    () => ({ enabled: true, provider: 'ollma', model: 'qwen3.5:4b', ...options }),
    () => replay(chunks),
    (_s, _t, _i, text, tok) => results.push({ kind: 'applied', text, tok }),
    (_s, _t, _i, reason) => results.push({ kind: 'failed', reason }),
  )
  q.enqueue({
    sessionId: 's', thinkId: 't', segmentIndex: 0,
    text: 'x'.repeat(400), provider: 'deepseek-official', fallbackModel: 'deepseek-flash',
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  return results[0] ?? { kind: 'silently-dropped' }
}

// ── 1. 终态语义：失败必须上报，成功必须落段 ──────────────────────────────────
check('文本成功落段',
  await refineOnce([
    { type: 'text-delta', text: '这是一段摘要' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
  { kind: 'applied', text: '这是一段摘要', tok: { input: 100, output: 6 } })

check('error 终态上报（含 provider/model 与 HTTP 状态）',
  await refineOnce([{ type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_HTTP_ERROR', status: 404, message: 'not found' } } }]),
  { kind: 'failed', reason: 'ollma/qwen3.5:4b error：PROVIDER_HTTP_ERROR HTTP 404 not found' })

check('max-tokens 无文本上报（预算被推理耗尽）',
  await refineOnce([{ type: 'finish', reason: { kind: 'max-tokens' } }]),
  { kind: 'failed', reason: 'ollma/qwen3.5:4b 未返回文本（finish=max-tokens）：预算被推理耗尽，请调大「精炼预算」' })

check('aborted 终态上报',
  await refineOnce([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'user cancelled' } } }]),
  { kind: 'failed', reason: 'ollma/qwen3.5:4b aborted：user cancelled' })

// ── 2. 路由解析 ──────────────────────────────────────────────────────────────
const providers = [{ id: 'deepseek-official' }, { id: 'ollma' }]
const catalog = { 'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], ollma: [{ id: 'qwen3.5:2b' }, { id: 'qwen3.5:4b' }] }
const windows = { 'deepseek-flash': 1_000_000, 'deepseek-v4-pro': 1_000_000, 'qwen3.5:2b': 32_000, 'qwen3.5:4b': 64_000 }
const llm = {
  stream: () => (async function* () {})(),
  listProviders: () => providers,
  listModels: async (p) => catalog[p] ?? [],
  resolveModelInfo: async (_p, m) => ({ context: { contextWindow: windows[m] } }),
}
const task = {
  sessionId: 's', thinkId: 't', segmentIndex: 0, text: 'x',
  provider: 'deepseek-official', fallbackModel: 'deepseek-flash',
}
const route = async (options) => (await resolveRefineRoute(llm, options, task)).route

check('auto 跟随主请求 provider', await route({ provider: 'auto', model: 'auto' }), { provider: 'deepseek-official', model: 'deepseek-flash' })
check('显式其他供应商 + auto 模型（选最小上下文窗口）', await route({ provider: 'ollma', model: 'auto' }), { provider: 'ollma', model: 'qwen3.5:2b' })
check('显式其他供应商 + 显式模型', await route({ provider: 'ollma', model: 'qwen3.5:4b' }), { provider: 'ollma', model: 'qwen3.5:4b' })
check('未注册供应商回退主请求 provider', await route({ provider: 'ghost', model: 'auto' }), { provider: 'deepseek-official', model: 'deepseek-flash' })

const legacy = { stream: () => (async function* () {})(), listModels: async () => { throw new Error('no catalog') } }
check('目录不可用（旧宿主）回退主模型',
  (await resolveRefineRoute(legacy, { provider: 'auto', model: 'auto' }, task)).route,
  { provider: 'deepseek-official', model: 'deepseek-flash' })
check('目录不可用 + 跨供应商不留错误模型',
  (await resolveRefineRoute(legacy, { provider: 'ollma', model: 'auto' }, task)).route,
  { provider: '', model: '' })
check('旧宿主 provider 目录为空', listProviderIds(legacy), [])

// ── 3. 精炼段选取：默认每个段都精炼 ─────────────────────────────────────────
check('默认（refineMinTokens 未设）小段也精炼', decideRefine({}, 80, false).tooSmall, false)
check('refineMinTokens=0 小段也精炼', decideRefine({ refineMinTokens: 0 }, 80, false).tooSmall, false)
check('refineMinTokens=1500 小段跳过并记原因',
  decideRefine({ refineMinTokens: 1500 }, 80, false),
  { minRefine: 1500, tooSmall: true, unrefinedReason: '段过小（80 tok < 1500）未精炼' })
check('末尾尾巴段即使过小也精炼', decideRefine({ refineMinTokens: 1500 }, 80, true).tooSmall, false)

// ── 4. 摘要归一化：小作文只取第一句，外壳去掉 ───────────────────────────────
check('多行小作文只取第一行/第一句',
  normalizeSummary('基于你提供的数据，核心目标很明确：\n1. **强制缩短**提示词\n2. 优化阈值'),
  '基于你提供的数据，核心目标很明确：')
check('列表符与编号去掉',
  normalizeSummary('- 我正在核对 baseURL 是否正确'),
  '我正在核对 baseURL 是否正确')
check('前导词“总结：”去掉',
  normalizeSummary('总结：已定位 404 并准备改 baseURL。'),
  '已定位 404 并准备改 baseURL。')
check('引号/反引号包裹去掉',
  normalizeSummary('“我正在重写精炼提示词”'),
  '我正在重写精炼提示词')
check('超长单句截断到 60 字符',
  normalizeSummary('我'.repeat(120)).length,
  61)
check('空内容归一化为空串', normalizeSummary('   \n  '), '')

// ── 5. 语言硬校验：英文（模型"接话"时的典型产物）必须被拒 ───────────────────
check('英文摘要被拒（要求中文）',
  await refineOnce([
    { type: 'text-delta', text: 'It is not a bug in your code or the system' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
  { kind: 'failed', reason: 'ollma/qwen3.5:4b 摘要不是中文：「It is not a bug in your code or the system」' })

// ── 6. 第二遍：整体摘要（段摘要 → 整次思考的一句话） ────────────────────────
/** 跑一次整体摘要：等过防抖窗口（1200ms），返回首个回调结果。 */
async function thinkOnce(chunks) {
  const results = []
  const q = new RefineQueue(
    () => ({ enabled: true, provider: 'ollma', model: 'qwen3.5:4b' }),
    () => replay(chunks),
    () => results.push({ kind: 'segment' }),
    () => results.push({ kind: 'segment-failed' }),
    (_s, _t, summary, tokens) => results.push({ kind: 'think', summary, tokens }),
    (_s, _t, reason) => results.push({ kind: 'think-failed', reason }),
  )
  q.enqueueThink({
    sessionId: 's', thinkId: 't', provider: 'ollama', fallbackModel: 'm',
    segments: ['我正在核对 baseURL。', '已确认 404 来自路径拼接。'],
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return results[0] ?? { kind: 'nothing' }
}

check('整体摘要落盘（第二遍）',
  await thinkOnce([
    { type: 'text-delta', text: '我在修 baseURL 的 404，已定方案待验证。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
  { kind: 'think', summary: '我在修 baseURL 的 404，已定方案待验证。', tokens: { input: 18, output: 15 } })

check('整体摘要同样受中文硬校验',
  await thinkOnce([
    { type: 'text-delta', text: 'I am fixing the baseURL 404' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
  { kind: 'think-failed', reason: 'ollma/qwen3.5:4b 摘要不是中文：「I am fixing the baseURL 404」' })

// ── 6.5 输出预算收敛与关思考能力探测（供应商 400 的真实根因） ────────────────
/** 假 llm：只提供 resolveModelInfo。 */
const infoLlm = (info) => ({ stream: () => (async function* () {})(), resolveModelInfo: async () => info })

check('声明了 maxTokens 的模型 → 用它作上限',
  await resolveOutputCap(infoLlm({ context: { contextWindow: 1048576 }, defaultMaxTokens: 65536 }), 'st', 'deepseek-v4-flash'),
  65536)
check('上限远小于 contextWindow 时以上限为准（st：ctx 1048576 / 上限 65536）',
  await resolveOutputCap(infoLlm({ context: { contextWindow: 1048576 }, defaultMaxTokens: 65536 }), 'st', 'deepseek-v4-flash') < 1048576,
  true)
check('未声明 maxTokens → 返回 undefined（不拿 contextWindow 顶替）',
  await resolveOutputCap(infoLlm({ context: { contextWindow: 1048576 } }), 'st', 'x'),
  undefined)
check('元数据查询抛错 → undefined',
  await resolveOutputCap({ stream: () => (async function* () {})(), resolveModelInfo: async () => { throw new Error('nope') } }, 'st', 'x'),
  undefined)
check('宿主无 resolveModelInfo（旧版）→ undefined',
  await resolveOutputCap({ stream: () => (async function* () {})() }, 'st', 'x'),
  undefined)

// 生产事故复现：用户设 refineOutputTokens = 9999999，商汤报
// "field MaxTokens invalid, should be in [1, 384000]"
check('上限已知：9999999 被收敛到供应商上限（商汤不再 400）',
  clampOutputTokens(9999999, 65536), 65536)
check('上限未知：保留用户配置值（buddy 等今天的可用行为不被改动）',
  clampOutputTokens(9999999, undefined), 9999999)
check('正常预算不变', clampOutputTokens(512, 65536), 512)
check('上限未知 + 正常预算也不变', clampOutputTokens(512, undefined), 512)
check('脏配置（0 / 负数 / NaN / undefined）→ 退回默认预算',
  [clampOutputTokens(0, 65536), clampOutputTokens(-5, undefined), clampOutputTokens(Number.NaN, 65536), clampOutputTokens(undefined, undefined)],
  [512, 512, 512, 512])
check('预算永不低于 1', clampOutputTokens(0.4, 65536), 1)

check('模型声明了 off 档位 → 可以关思考',
  await canDisableReasoning(infoLlm({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }), 'ollma', 'qwen3.5:4b'),
  true)
check('模型未声明 off（只有思考档位）→ 不发，避免把可用路由打成失败',
  await canDisableReasoning(infoLlm({ reasoning: { efforts: [{ id: 'high' }] } }), 'st', 'x'),
  false)
check('完全没有 reasoning 能力 → 不发',
  await canDisableReasoning(infoLlm({}), 'st', 'x'),
  false)
check('能力查询抛错 → 不发（保守：不破坏可用请求）',
  await canDisableReasoning({ stream: () => (async function* () {})(), resolveModelInfo: async () => { throw new Error('nope') } }, 'st', 'x'),
  false)

// ── 7. 任务看板翻译：手动触发、给什么翻什么、按原文缓存 ──────────────────────
/** 假 llm + 调用计数；译文按行对应请求里的条目顺序。 */
function todoTranslator(lines, counter = { calls: 0 }) {
  const t = createTodoTranslator(
    () => ({ refineProvider: 'ollma', refineModel: 'qwen3.5:4b', refineOutputTokens: 512, todoTranslatePrompt: 'p' }),
    () => ({
      stream: () => {
        counter.calls++
        return (async function* () {
          yield { type: 'text-delta', text: lines.join('\n') }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
    () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  )
  return { t, counter }
}

const empty = todoTranslator(['不该被调用'])
check('没有条目 → 不调模型', [await empty.t.translate([], 's'), empty.counter.calls], [{}, 0])

const manual = todoTranslator(['修复 baseURL 的 404', '改善看板按钮'])
check('给什么翻什么（不挑条目）',
  await manual.t.translate(['Fix the baseURL 404', 'Improve the board button'], 's'),
  { 'Fix the baseURL 404': '修复 baseURL 的 404', 'Improve the board button': '改善看板按钮' })

check('同一条目再翻 → 命中缓存，不调模型',
  [await manual.t.translate(['Fix the baseURL 404'], 's'), manual.counter.calls],
  [{ 'Fix the baseURL 404': '修复 baseURL 的 404' }, 1])

const filtered = todoTranslator(['只翻这条'])
check('非字符串/空串被剔除、重复项只翻一次',
  await filtered.t.translate(['', 42, 'Only this one', 'Only this one'], 's'),
  { 'Only this one': '只翻这条' })

const truncated = { calls: 0 }
const many = todoTranslator(Array.from({ length: 60 }, (_, i) => `第${i}条`), truncated)
const capped = await many.t.translate(Array.from({ length: 60 }, (_, i) => `item ${i}`), 's')
check('单次条目数封顶（60 条请求 → 只翻 40 条）',
  [Object.keys(capped).length, truncated.calls], [40, 1])

const partial = todoTranslator(['只有一行译文'])
check('模型少给译文 → 缺的条目就不出现在结果里',
  await partial.t.translate(['First line', 'Second line'], 's'),
  { 'First line': '只有一行译文' })

console.log(failures === 0 ? '\n[dsh-think-summary] refine-check: all passed' : `\n[dsh-think-summary] refine-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
