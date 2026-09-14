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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RefineQueue, resolveRefineRoute, listProviderIds, normalizeSummary, resolveOutputCap, clampOutputTokens, canDisableReasoning } from '../lib/host/summarize/refine.js'
import { decideRefine } from '../lib/host/summarize/pipeline.js'
import { createTodoTranslator } from '../lib/host/todo.js'
import { ModelPool, ModelPoolManager, parseModelPool, formatModelRef, POOL_DEFAULTS, shouldDisableReasoning } from '../lib/host/pool.js'
import { PoolStats, healthOf, MIN_ATTEMPTS_FOR_COLOR } from '../lib/host/pool-stats.js'

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

// ── 6.5 整体摘要也必须走模型池（此前漏接，第二遍绕过池子走单模型） ──────────
{
  // 池子里只有 st/a；注入池子后，整体摘要必须请求 st/a，而不是配置里的 ollma
  const results = []
  const seen = []
  const q = new RefineQueue(
    () => ({ enabled: true, provider: 'ollma', model: 'qwen3.5:4b' }),
    () => ({
      stream: (opts) => {
        seen.push(opts.provider + '/' + opts.model)
        return (async function* () {
          yield { type: 'text-delta', text: '我在核对第二遍摘要是否走池子。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
    () => results.push({ kind: 'segment' }),
    () => results.push({ kind: 'segment-failed' }),
    (_s, _t, summary) => results.push({ kind: 'think', summary }),
    (_s, _t, reason) => results.push({ kind: 'think-failed', reason }),
  )
  q.usePool(new ModelPoolManager(() => parseModelPool(['st/a']), () => 1))
  q.enqueueThink({
    sessionId: 's', thinkId: 't', provider: 'ollama', fallbackModel: 'm',
    segments: ['我正在核对 baseURL。', '已确认 404 来自路径拼接。'],
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  check('整体摘要走模型池（请求落在池内模型，而非配置的单模型）',
    [seen, results[0]],
    [['st/a'], { kind: 'think', summary: '我在核对第二遍摘要是否走池子。' }])
}

// 整体摘要与段精炼共用池子 → 失败原因（含错误码）写回 think
{
  const results = []
  const q = new RefineQueue(
    () => ({ enabled: true, provider: 'ollma', model: 'qwen3.5:4b', poolMaxAttempts: 1 }),
    () => ({
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'rpm exhausted' } } }
      })(),
    }),
    () => results.push({ kind: 'segment' }),
    () => results.push({ kind: 'segment-failed' }),
    (_s, _t, summary) => results.push({ kind: 'think', summary }),
    (_s, _t, reason) => results.push({ kind: 'think-failed', reason }),
  )
  q.usePool(new ModelPoolManager(() => parseModelPool(['st/a']), () => 1))
  q.enqueueThink({
    sessionId: 's', thinkId: 't', provider: 'ollama', fallbackModel: 'm',
    segments: ['段一。', '段二。'],
  })
  // 等防抖 1.2s + 一轮尝试；poolMaxAttempts=1 时不进入换模型重投，快速失败
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const failed = results.find((r) => r.kind === 'think-failed')
  check('整体摘要失败会写回原因（含错误码）',
    /RATE_LIMIT/.test((failed || {}).reason || ''),
    true)
}

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
check('没有条目 → 不调模型', [await empty.t.translate([], 's'), empty.counter.calls], [{ translations: {} }, 0])

const manual = todoTranslator(['修复 baseURL 的 404', '改善看板按钮'])
check('给什么翻什么（不挑条目）',
  await manual.t.translate(['Fix the baseURL 404', 'Improve the board button'], 's'),
  { translations: { 'Fix the baseURL 404': '修复 baseURL 的 404', 'Improve the board button': '改善看板按钮' } })

check('同一条目再翻 → 命中缓存，不调模型',
  [await manual.t.translate(['Fix the baseURL 404'], 's'), manual.counter.calls],
  [{ translations: { 'Fix the baseURL 404': '修复 baseURL 的 404' } }, 1])

const filtered = todoTranslator(['只翻这条'])
check('非字符串/空串被剔除、重复项只翻一次',
  await filtered.t.translate(['', 42, 'Only this one', 'Only this one'], 's'),
  { translations: { 'Only this one': '只翻这条' } })

const truncated = { calls: 0 }
const many = todoTranslator(Array.from({ length: 60 }, (_, i) => `第${i}条`), truncated)
const capped = await many.t.translate(Array.from({ length: 60 }, (_, i) => `item ${i}`), 's')
check('单次条目数封顶（60 条请求 → 只翻 40 条）',
  [Object.keys(capped.translations).length, truncated.calls], [40, 1])

const partial = todoTranslator(['只有一行译文'])
check('模型少给译文 → 缺的条目就不出现在结果里',
  await partial.t.translate(['First line', 'Second line'], 's'),
  { translations: { 'First line': '只有一行译文' } })

// 失败也要把原因（含错误码）带给界面，不能静默返回空
const failing = createTodoTranslator(
  () => ({ refineProvider: 'st', refineModel: 'sensenova-6.8-flash-lite', refineOutputTokens: 512, todoTranslatePrompt: 'p' }),
  () => ({
    stream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'rpm exhausted' } } }
    })(),
  }),
  () => ({ provider: 'st', model: 'sensenova-6.8-flash-lite' }),
)
const failedRes = await failing.translate(['Fix it'], 's')
check('翻译失败 → 翻译结果为空但带 error（含码与状态）',
  [failedRes.translations, /RATE_LIMIT/.test(failedRes.error || ''), /HTTP 429/.test(failedRes.error || '')],
  [{}, true, true])

// ── 8. 错误码抽取（界面直显，用户要求"不用翻日志"） ─────────────────────────
// 这两个是 bundle 的**内部**函数（不在 exports 里），所以取拼接后的模块体重求值：
// 去掉 ModuleLoader 外壳，只留 body（拼接的纯 JS），追加一行把目标函数递出来。
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const bodyStart = clientSrc.indexOf('var React = require("react");')
const bodyEnd = clientSrc.lastIndexOf('return module.exports;')
if (bodyStart < 0 || bodyEnd < 0) {
  console.error('FAIL 无法定位 client bundle 的模块体（构建产物结构变了？）')
  failures++
}
const clientBody = clientSrc
  .slice(bodyStart + 'var React = require("react");'.length, bodyEnd)
  // 末段是 build 生成的 `exports.x = x;`（CommonJS 味道）——new Function 里会与
  // 顶层的 await 撞上 Node 的"模块格式不明确"检查，这里只做纯函数测试，直接剥掉。
  .replace(/^\s*exports\.[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*;\s*$/gm, '')
const reactStub = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, Fragment: 'f' }
// eslint-disable-next-line no-new-func -- 仅测试：求值拼接后的客户端模块体以取内部纯函数
const { errCodeOf, shortErr } = new Function('React', clientBody + '\nreturn { errCodeOf, shortErr };')(reactStub)

check('错误码：RATE_LIMIT + 429（商汤 rpm exhausted 的真实形状）',
  errCodeOf('精炼失败：st/deepseek-v4-flash error：RATE_LIMIT 429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}'),
  'RATE_LIMIT 429')
check('错误码：INVALID_REQUEST + 400（MaxTokens 事故的形状）',
  errCodeOf('精炼失败：st/sensenova-6.8-flash-lite error：INVALID_REQUEST 400: {"message":"inference request is invalid","code":"400"}'),
  'INVALID_REQUEST 400')
check('错误码：无 HTTP 状态时取首个大写码（UNKNOWN_MODEL）',
  errCodeOf('精炼失败：ollma/qwen3.5:2b error：UNKNOWN_MODEL pi-ai provider "ollma" has no configured model'),
  'UNKNOWN_MODEL')
check('错误码：超时',
  errCodeOf('精炼失败：refine timeout after 60000ms'),
  'TIMEOUT')
check('错误码：预算被推理耗尽（max-tokens）',
  errCodeOf('精炼失败：ollma/qwen3.5:4b 未返回文本（finish=max-tokens）：预算被推理耗尽，请调大「精炼预算」'),
  'MAX_TOKENS')
check('错误码：宿主无 llm 服务',
  errCodeOf('llm 服务不可用（宿主未挂载）'),
  'NO_LLM')
check('错误码：抽不到码时返回空串（不造假码）',
  [errCodeOf('精炼失败：模型抽风了'), errCodeOf(''), errCodeOf(undefined)],
  ['', '', ''])
check('短文案：有码用码', shortErr('精炼失败：st/x error：RATE_LIMIT 429: {"message":"rpm exhausted"}'), 'RATE_LIMIT 429')
check('短文案：无码则单行截断（不把整段 JSON 顶到界面）',
  shortErr('精炼失败：' + 'x'.repeat(100)).length <= 41,
  true)

// ── 9. 模型池：解析、轮转、每模型并发、指数退避 ──────────────────────────────
check('池子解析：字符串 provider/model', parseModelPool(['st/a', 'st/b']), [{ provider: 'st', model: 'a' }, { provider: 'st', model: 'b' }])
check('池子解析：容忍 {provider,model} 对象', parseModelPool([{ provider: 'x', model: 'y' }]), [{ provider: 'x', model: 'y' }])
check('池子解析：去空、去重、丢弃无斜杠项、保持顺序',
  parseModelPool(['st/a', '', '  ', 'st/a', 'noslash', 'st/', '/b', 'st/c']),
  [{ provider: 'st', model: 'a' }, { provider: 'st', model: 'c' }])
check('池子解析：非数组 → 空', [parseModelPool(undefined), parseModelPool('st/a'), parseModelPool(null)], [[], [], []])

/** 可控时钟的池子。 */
function mkPool(refs, perModel = 1) {
  let t = 0
  const pool = new ModelPool(parseModelPool(refs), {
    perModelConcurrency: perModel,
    backoffBaseMs: 1000,
    backoffMaxMs: 8000,
    now: () => t,
  })
  return { pool, advance: (ms) => { t += ms }, at: () => t }
}

// 轮转：3 个模型应依次取用，而不是盯着第一个
{
  const { pool } = mkPool(['st/a', 'st/b', 'st/c'])
  const seq = []
  for (let i = 0; i < 6; i++) {
    const ref = pool.pick()
    seq.push(formatModelRef(ref))
    pool.acquire(ref)
    pool.release(ref)
  }
  check('轮转：多模型依次取用（a,b,c,a,b,c）', seq, ['st/a', 'st/b', 'st/c', 'st/a', 'st/b', 'st/c'])
}

// 每模型并发：perModel=1 时同一模型不能同时占两个位
{
  const { pool } = mkPool(['st/a', 'st/b'], 1)
  const first = pool.pick()
  pool.acquire(first)
  const second = pool.pick()
  check('每模型并发=1：第一个占满后轮到另一个模型', formatModelRef(second), 'st/b')
  pool.acquire(second)
  check('每模型并发=1：都占满后没有可取模型', pool.pick(), undefined)
  pool.release(first)
  check('释放后重新可取', formatModelRef(pool.pick()), 'st/a')
}

// 每模型并发=2：同一模型可占两个位
{
  const { pool } = mkPool(['st/a'], 2)
  const one = pool.pick(); pool.acquire(one)
  const two = pool.pick()
  check('每模型并发=2：同一模型可占两位', [formatModelRef(one), formatModelRef(two)], ['st/a', 'st/a'])
  pool.acquire(two)
  check('每模型并发=2：占满两位后不可再取', pool.pick(), undefined)
}

// 指数退避：失败后该模型被跳过，其他模型顶上；退避按 1s→2s→4s 增长
{
  const { pool, advance } = mkPool(['st/a', 'st/b'], 1)
  const a = { provider: 'st', model: 'a' }
  const b = { provider: 'st', model: 'b' }
  const d1 = pool.failed(a)
  check('退避：首次失败 1000ms', d1, 1000)
  check('退避：失败的模型被跳过，另一个顶上', formatModelRef(pool.pick()), 'st/b')
  const d2 = pool.failed(a)
  check('退避：连续失败按指数增长（2000ms）', d2, 2000)
  const d3 = pool.failed(a)
  check('退避：再翻倍（4000ms）', d3, 4000)
  const d4 = pool.failed(a)
  check('退避：再翻倍（8000ms，正好到上限）', d4, 8000)
  // 退避到上限后不再增长
  check('退避：封顶 8000ms', pool.failed(a), 8000)
  // 时间推进：退避到期后该模型恢复可被取用
  const { pool: p2, advance: adv2 } = mkPool(['st/a'], 1)
  p2.failed({ provider: 'st', model: 'a' })
  check('退避中：不可取用', p2.pick(), undefined)
  adv2(1001)
  check('退避到期：恢复可取用', formatModelRef(p2.pick()), 'st/a')
  void advance
  void b
}

// 成功清零退避等级
{
  const { pool } = mkPool(['st/a'], 1)
  const a = { provider: 'st', model: 'a' }
  pool.failed(a)
  pool.succeeded(a)
  check('成功后退避等级清零（下次失败重新从 1000ms 起）', pool.failed(a), 1000)
}

// nextWakeMs：告诉调用方还要等多久（用于安排重试），有可用模型时为 0
{
  const { pool } = mkPool(['st/a', 'st/b'], 1)
  check('有可用模型时无需等待', pool.nextWakeMs(), 0)
  pool.failed({ provider: 'st', model: 'a' })
  check('还有另一个模型可用 → 仍无需等待', pool.nextWakeMs(), 0)
  pool.failed({ provider: 'st', model: 'b' })
  check('全部退避 → 返回最早到期时间', pool.nextWakeMs(), 1000)
}

// 池子管理器：配置变化才重建（退避状态随之重置）
{
  let refs = ['st/a']
  let perModel = 1
  const mgr = new ModelPoolManager(() => parseModelPool(refs), () => perModel)
  const first = mgr.current()
  check('管理器：配置未变时复用同一池子', mgr.current() === first, true)
  refs = ['st/a', 'st/b']
  check('管理器：模型清单变化则重建', mgr.current() !== first, true)
  const third = mgr.current()
  perModel = 2
  check('管理器：每模型并发变化也重建', mgr.current() !== third, true)
}

check('POOL_DEFAULTS 面向免费模型（每模型 1 并发）', POOL_DEFAULTS.perModelConcurrency, 1)

// ── 10. 自动开关思考：首次不带，重试才带 ─────────────────────────────────────
check('关思考=关 → 永不发送', [shouldDisableReasoning(false, 0), shouldDisableReasoning(false, 1), shouldDisableReasoning(false, 5)], [false, false, false])
check('关思考=开 → 首次不带（先按供应商默认）', shouldDisableReasoning(true, 0), false)
check('关思考=开 → 重试时带上（自动救回"预算被推理烧光"）', [shouldDisableReasoning(true, 1), shouldDisableReasoning(true, 2)], [true, true])

// 池子里的尝试计数驱动上面的开关：成功后退避清零、尝试序号归零
{
  const { pool } = mkPool(['st/a'], 1)
  const a = { provider: 'st', model: 'a' }
  check('尝试计数从 0 起', pool.attemptsOf(a), 0)
  pool.noteAttempt(a)
  pool.noteAttempt(a)
  check('noteAttempt 累加', pool.attemptsOf(a), 2)
  pool.succeeded(a)
  check('成功后尝试计数归零（下次又从"不带"开始）', pool.attemptsOf(a), 0)
}

// ── 11. 状态色分档（绿/黄/红/不显示） ────────────────────────────────────────
check('样本不足（<5 次）不显示颜色', [healthOf({ ok: 0, fail: 4 }), healthOf({ ok: 1, fail: 0 })], ['unknown', 'unknown'])
check('尝试数 = 5 才开始显示：一次没成功 → 红', healthOf({ ok: 0, fail: 5 }), 'red')
check('成功率 ≥50% → 绿', [healthOf({ ok: 5, fail: 5 }), healthOf({ ok: 9, fail: 1 })], ['green', 'green'])
check('成功率 <50% 但成功过 → 黄', healthOf({ ok: 1, fail: 9 }), 'yellow')
check('未记录 → 不显示', [healthOf(undefined), healthOf(null)], ['unknown', 'unknown'])
check('颜色门槛常量 = 5', MIN_ATTEMPTS_FOR_COLOR, 5)

// ── 12. 统计持久化（跨进程累计，气泡颜色才有意义） ──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-poolstats-'))
  const s1 = new PoolStats(dir)
  s1.recordOk('st/a')
  s1.recordOk('st/a')
  s1.recordFail('st/a')
  s1.recordFail('st/b')
  s1.flush()
  // 模拟重启：新实例从磁盘恢复
  const s2 = new PoolStats(dir)
  check('重启后统计仍在（成功/失败都恢复）', [s2.get('st/a'), s2.get('st/b')], [{ ok: 2, fail: 1 }, { ok: 0, fail: 1 }])
  check('累计后可判定颜色（3/3 样本不足仍是 unknown）', healthOf(s2.get('st/a')), 'unknown')
  s2.recordOk('st/a')
  s2.recordOk('st/a')
  s2.flush()
  const s3 = new PoolStats(dir)
  check('跨实例累计到 5 次后开始显示', healthOf(s3.get('st/a')), 'green')
  // 损坏文件不阻断启动
  writeFileSync(join(dir, 'dsh-think-summary-pool.json'), '{ 这不是 JSON', 'utf8')
  let broken
  try { broken = new PoolStats(dir) } catch (e) { broken = 'threw: ' + e.message }
  check('统计文件损坏 → 空统计、不抛异常', [broken instanceof PoolStats, broken.get('st/a')], [true, undefined])
  rmSync(dir, { recursive: true, force: true })
}

// 池子把成功/失败喂给统计（气泡颜色真正由精炼结果驱动）
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-poolstats2-'))
  const stats = new PoolStats(dir)
  const pool = new ModelPool(parseModelPool(['st/a']), {
    perModelConcurrency: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, stats,
  })
  const a = { provider: 'st', model: 'a' }
  pool.succeeded(a)
  pool.failed(a)
  stats.flush()
  check('池子的 success/fail 会写进统计', new PoolStats(dir).get('st/a'), { ok: 1, fail: 1 })
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n[dsh-think-summary] refine-check: all passed' : `\n[dsh-think-summary] refine-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
