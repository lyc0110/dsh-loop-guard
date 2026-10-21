/**
 * dsh-loop-guard — 在 `llm/stream` 水位线上拦截「思考/正文退化成重复循环」的模型输出。
 *
 * 故障原型（DeepSeek flash 档模型，经第三方兼容网关接入）：
 * 某个 step 的 reasoning 流退化成 `写。` / `执行。` / `**写 pwsh**。` 的周期性重复，
 * 单轮产出 82,524 字符、14,266 行里只有 47 种不同行，正文与工具调用均为 0。
 * 因为它全部落在 reasoning-delta 内、又不涉及任何工具调用：
 *   - repeat-tool-reminder 只看「同名工具 + 相同参数」，永不触发；
 *   - maxTokens 尚有巨大余额，不会命中；
 *   - agent-loop 不做任何流内重复检测；
 * 于是唯一的刹车是用户手动中断。
 *
 * 本插件在流式增量上做在线周期性检测：把「末尾 probeChars 个字符」当作指纹，在最近
 * regionChars 字符的窗口里数它出现了几次，达到 minOccurrences 就判定退化。12 万字符
 * 的正常输出里，一个 96 字符的片段重复出现 5 次以上的概率可以忽略；而退化流的周期
 * 通常只有几十到几百字符，几百字符内就会撞满阈值。
 *
 * 命中后默认抛出 `code = 'repetition-loop'` 的错误：agent-loop 早已有「流中途出错」
 * 的完整清理路径（网络断流天天发生），能安全收尾成 error finish；相比伪造
 * block-end + finish 更不容易把半截消息塞进上下文。
 */

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'loop-guard'
export const inject = ['llm']

const DEFAULTS = {
  providers: [],
  models: [],
  probeChars: 96,
  regionChars: 3072,
  minOccurrences: 5,
  minTotalChars: 2048,
  checkEveryChars: 128,
  maxTotalChars: 0,
  lineWindow: 400,
  maxUniqueLines: 40,
  lineMinChars: 2,
  lineCheckEvery: 20,
  onDetect: 'throw',
  dryRun: false,
  logFile: '',
}

/**
 * 读一个正整数配置项，非法值一律退回默认，绝不让配置写错把插件炸掉。
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [range]
 * @returns {number}
 */
function toPositiveInt(value, fallback, range = {}) {
  const min = range.min ?? 1
  const max = range.max ?? 1_000_000_000
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min || i > max) return fallback
  return i
}

/** @param {unknown} value @returns {string[]} */
function toList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter((item) => item.length > 0)
}

/**
 * 归一化配置。
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cfg = {
    providers: toList(input.providers),
    models: toList(input.models),
    probeChars: toPositiveInt(input.probeChars, DEFAULTS.probeChars, { min: 16, max: 4096 }),
    regionChars: toPositiveInt(input.regionChars, DEFAULTS.regionChars, { min: 256, max: 1_000_000 }),
    minOccurrences: toPositiveInt(input.minOccurrences, DEFAULTS.minOccurrences, { min: 2, max: 1000 }),
    minTotalChars: toPositiveInt(input.minTotalChars, DEFAULTS.minTotalChars, { min: 0, max: 100_000_000 }),
    checkEveryChars: toPositiveInt(input.checkEveryChars, DEFAULTS.checkEveryChars, { min: 8, max: 65536 }),
    maxTotalChars: toPositiveInt(input.maxTotalChars, DEFAULTS.maxTotalChars, { min: 0, max: 100_000_000 }),
    lineWindow: toPositiveInt(input.lineWindow, DEFAULTS.lineWindow, { min: 40, max: 20000 }),
    maxUniqueLines: toPositiveInt(input.maxUniqueLines, DEFAULTS.maxUniqueLines, { min: 2, max: 20000 }),
    lineMinChars: toPositiveInt(input.lineMinChars, DEFAULTS.lineMinChars, { min: 1, max: 64 }),
    lineCheckEvery: toPositiveInt(input.lineCheckEvery, DEFAULTS.lineCheckEvery, { min: 1, max: 10000 }),
    onDetect: input.onDetect === 'end' ? 'end' : DEFAULTS.onDetect,
    dryRun: input.dryRun === true,
    logFile: typeof input.logFile === 'string' ? input.logFile.trim() : '',
  }
  // 窗口必须至少塞得下 minOccurrences 个指纹，否则永远不可能命中。
  const minimumRegion = cfg.probeChars * cfg.minOccurrences
  if (cfg.regionChars < minimumRegion) cfg.regionChars = minimumRegion
  // 唯一行上限不可能超过窗口本身。
  if (cfg.maxUniqueLines >= cfg.lineWindow) cfg.maxUniqueLines = Math.max(2, Math.floor(cfg.lineWindow / 2))
  return cfg
}

/**
 * 判断这次请求是否在管辖范围内。
 * @param {typeof DEFAULTS} cfg
 * @param {{ provider?: string, model?: string }} options
 */
function applies(cfg, options) {
  if (cfg.providers.length > 0 && !cfg.providers.includes(String(options.provider))) return false
  if (cfg.models.length > 0 && !cfg.models.includes(String(options.model))) return false
  return true
}

/** 一次流式尝试的检测状态。 */
export function createState() {
  return {
    buffers: new Map(),
    sinceCheck: 0,
    totalChars: 0,
    pending: '',
    lines: [],
    linesSinceCheck: 0,
    reported: false,
  }
}

/**
 * 纯函数：在一个窗口里数「末尾指纹」出现了几次。
 * @param {string} buf
 * @param {{ probeChars: number, regionChars: number, minOccurrences: number }} cfg
 * @returns {{ occurrences: number, sample: string } | null}
 */
export function scan(buf, cfg) {
  const n = buf.length
  const probe = cfg.probeChars
  if (n < probe * cfg.minOccurrences) return null
  const needle = buf.slice(n - probe)
  let occurrences = 0
  let cursor = Math.max(0, n - cfg.regionChars)
  for (;;) {
    const at = buf.indexOf(needle, cursor)
    if (at === -1) return null
    occurrences += 1
    if (occurrences >= cfg.minOccurrences) return { occurrences, sample: needle }
    cursor = at + 1
  }
}

/**
 * 行级塌缩检测：把增量按行切开，维护最近 lineWindow 条「有内容的行」，
 * 如果这个窗口里不同行的数量少到 maxUniqueLines 以下，判定退化。
 *
 * 这一条是本次故障的主力检测器：真实退化流的 14,266 行里只有 47 种不同行
 * （`写。`/`执行。`/`**写 pwsh**。` …），几百行内就能撞线，比字符周期检测快两个
 * 数量级。反过来，正常的代码/表格/散文文件在 400 行窗口里唯一行数通常远超 40，
 * 空行与单个括号（trim 后长度 < lineMinChars）不计入统计。
 * @returns {{ reason: string, kind: string, occurrences: number, sample: string, totalChars: number } | null}
 */
function feedLines(state, kind, text, cfg) {
  state.pending += text
  // 单行过长（比如一整段没有换行的文本）时别无限攒着。
  if (state.pending.length > 1_000_000) state.pending = state.pending.slice(-cfg.regionChars)

  const lastBreak = state.pending.lastIndexOf('\n')
  if (lastBreak === -1) return null

  const complete = state.pending.slice(0, lastBreak)
  state.pending = state.pending.slice(lastBreak + 1)
  for (const raw of complete.split('\n')) {
    const line = raw.trim()
    if (line.length < cfg.lineMinChars) continue
    state.lines.push(line)
    state.linesSinceCheck += 1
  }
  if (state.lines.length > cfg.lineWindow) state.lines.splice(0, state.lines.length - cfg.lineWindow)

  if (state.linesSinceCheck < cfg.lineCheckEvery) return null
  state.linesSinceCheck = 0
  if (state.lines.length < cfg.lineWindow) return null

  const counts = new Map()
  for (const line of state.lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  if (counts.size > cfg.maxUniqueLines) return null

  let sample = ''
  let sampleCount = 0
  for (const [line, n] of counts) {
    if (n > sampleCount) {
      sampleCount = n
      sample = line
    }
  }
  return { reason: 'line-collapse', kind, occurrences: sampleCount, sample, totalChars: state.totalChars }
}

/**
 * 吃进一个 chunk，更新状态，必要时返回命中信息。
 * 只关心 reasoning-delta 与 text-delta；工具调用参数不在检测范围内（那类重复由
 * repeat-tool-reminder 覆盖）。
 * @param {ReturnType<typeof createState>} state
 * @param {{ type?: string, text?: string }} chunk
 * @param {typeof DEFAULTS} cfg
 * @returns {{ reason: string, kind: string, occurrences?: number, sample?: string, totalChars: number } | null}
 */
export function observe(state, chunk, cfg) {
  let kind = null
  if (chunk && chunk.type === 'reasoning-delta') kind = 'reasoning'
  else if (chunk && chunk.type === 'text-delta') kind = 'text'
  if (kind === null) return null

  const text = typeof chunk.text === 'string' ? chunk.text : ''
  if (text.length === 0) return null

  state.totalChars += text.length

  const keep = cfg.regionChars + cfg.probeChars
  let buf = (state.buffers.get(kind) ?? '') + text
  if (buf.length > keep) buf = buf.slice(buf.length - keep)
  state.buffers.set(kind, buf)

  if (cfg.maxTotalChars > 0 && state.totalChars >= cfg.maxTotalChars) {
    return { reason: 'max-total-chars', kind, totalChars: state.totalChars }
  }

  const lineHit = feedLines(state, kind, text, cfg)
  if (lineHit) return lineHit

  state.sinceCheck += text.length
  if (state.sinceCheck < cfg.checkEveryChars) return null
  state.sinceCheck = 0

  if (state.totalChars < cfg.minTotalChars) return null

  const hit = scan(buf, cfg)
  if (!hit) return null
  return { reason: 'repetition', kind, occurrences: hit.occurrences, sample: hit.sample, totalChars: state.totalChars }
}

/**
 * 命中时的错误对象：code 用自定义值，避免落进 llm-retry 的可重试码表，
 * 免得在同一个退化点上反复重试烧 token。
 * @param {typeof DEFAULTS} cfg
 * @param {{ provider?: string, model?: string, purpose?: string }} meta
 * @param {{ reason: string, kind: string, occurrences?: number, totalChars: number }} hit
 */
function loopError(cfg, meta, hit) {
  let detail
  if (hit.reason === 'max-total-chars') {
    detail = `单次输出累计 ${hit.totalChars} 字符，超过 maxTotalChars=${cfg.maxTotalChars}`
  } else if (hit.reason === 'line-collapse') {
    detail = `${hit.kind === 'reasoning' ? '思考' : '正文'}输出塌缩成极少几种行：最近 ${cfg.lineWindow} 行里只有不超过 ${cfg.maxUniqueLines} 种不同行（最高频行重复 ${hit.occurrences} 次），累计输出 ${hit.totalChars} 字符`
  } else {
    detail = `${hit.kind === 'reasoning' ? '思考' : '正文'}输出退化为重复循环：末尾 ${cfg.probeChars} 字符片段在最近 ${cfg.regionChars} 字符内重复出现 ${hit.occurrences} 次，累计输出 ${hit.totalChars} 字符`
  }
  const error = new Error(`[loop-guard] ${detail}，已中断本次请求（provider=${meta.provider} model=${meta.model}）。这是生成退化，不是任务失败；请勿重放同样的动作。`)
  error.name = 'LlmRepetitionLoopError'
  error.code = 'repetition-loop'
  error.loopGuard = { ...hit, provider: meta.provider, model: meta.model, purpose: meta.purpose }
  return error
}

/**
 * 写一条命中记录。
 * @param {{ warn: (msg: string) => void }} logger
 * @param {typeof DEFAULTS} cfg
 * @param {{ provider?: string, model?: string, purpose?: string, sessionId?: string }} meta
 * @param {{ reason: string, kind: string, occurrences?: number, totalChars: number, sample?: string }} hit
 */
function report(logger, cfg, meta, hit) {
  const where = [
    `provider=${meta.provider ?? '?'}`,
    `model=${meta.model ?? '?'}`,
    meta.purpose ? `purpose=${meta.purpose}` : '',
    meta.sessionId ? `session=${meta.sessionId}` : '',
  ].filter(Boolean).join(' ')
  const sample = hit.sample ? ` sample=${JSON.stringify(hit.sample.slice(0, 60))}` : ''
  const line = `[loop-guard] ${hit.reason} kind=${hit.kind} occurrences=${hit.occurrences ?? '-'} totalChars=${hit.totalChars}${sample} ${where}`
  logger.warn(line)
  if (!cfg.logFile) return
  try {
    appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch (error) {
    logger.warn(`[loop-guard] 命中日志写入失败：${error?.message ?? error}`)
  }
}

/**
 * 包住下游流：逐块检查，命中就掐断。
 * @param {{ warn: (msg: string) => void }} logger
 * @param {typeof DEFAULTS} cfg
 * @param {{ provider?: string, model?: string, purpose?: string, sessionId?: string }} options
 * @param {AsyncIterable<any>} downstream
 */
async function* guardStream(logger, cfg, options, downstream) {
  const state = createState()
  const meta = {
    provider: options?.provider,
    model: options?.model,
    purpose: options?.purpose,
    sessionId: options?.sessionId,
  }
  const iterator = downstream[Symbol.asyncIterator]()
  let exhausted = false
  try {
    for (;;) {
      const step = await iterator.next()
      if (step.done) {
        exhausted = true
        return
      }
      const chunk = step.value

      let hit = null
      try {
        hit = observe(state, chunk, cfg)
      } catch (error) {
        // 检测本身绝不能成为故障源：出任何异常都按「这一块没命中」处理。
        hit = null
        logger.warn(`[loop-guard] 检测异常，已忽略：${error?.message ?? error}`)
      }

      if (hit && !state.reported) {
        state.reported = true
        report(logger, cfg, meta, hit)
      }

      if (hit && !cfg.dryRun) {
        if (cfg.onDetect === 'end') {
          exhausted = true
          return
        }
        throw loopError(cfg, meta, hit)
      }

      yield chunk
    }
  } finally {
    if (!exhausted && typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {
        // 下游清理失败不应盖住真正的错误。
      }
    }
  }
}

/**
 * 插件入口。
 * @param {{ logger: any, on: Function, effect: Function }} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const logger = ctx.logger

  ctx.effect(() => {
    logger.info(
      '[loop-guard] 已启用 probe=%d region=%d minOcc=%d minTotal=%d maxTotal=%d onDetect=%s dryRun=%s',
      cfg.probeChars,
      cfg.regionChars,
      cfg.minOccurrences,
      cfg.minTotalChars,
      cfg.maxTotalChars,
      cfg.onDetect,
      String(cfg.dryRun),
    )
    return () => logger.info('[loop-guard] 已停用')
  }, 'loop-guard.lifecycle')

  ctx.on(
    'llm/stream',
    (options, next) => {
      if (!applies(cfg, options ?? {})) return next()
      const downstream = next()
      if (!downstream || typeof downstream[Symbol.asyncIterator] !== 'function') return downstream
      return guardStream(logger, cfg, options ?? {}, downstream)
    },
    { prepend: true },
  )
}

export default { name, inject, apply }

/** 自检：`node lib/index.js`。规则一旦失灵必须当场炸掉。 */
async function runSelfTest() {
  const cfg = resolveConfig({})

  /** 把文本切成 size 字符一片，模拟流式增量。 */
  const chunked = (text, size, type = 'reasoning-delta') => {
    const out = []
    for (let i = 0; i < text.length; i += size) out.push({ type, index: 0, text: text.slice(i, i + size) })
    return out
  }

  const run = (chunks, config = cfg) => {
    const state = createState()
    for (const chunk of chunks) {
      const hit = observe(state, chunk, config)
      if (hit) return { hit, state }
    }
    return { hit: null, state }
  }

  // 近似模板但每行都不同：真实长清单就长这样，绝不能误杀。
  const normal = Array.from(
    { length: 900 },
    (_, i) => `第 ${i} 项检查通过，累计 ${i * 37} 字节，剩余 ${i * 13} 毫秒，位置 ${i * 7}。`,
  ).join('')

  // 真·散文：60 句互不相同的段落轮着来，一轮约 4 千字符 > 回看窗口。
  const pool = Array.from(
    { length: 60 },
    (_, i) => `关于第 ${['方案', '证据', '时间线', '回滚', '口径'][i % 5]}这件事，第 ${i} 次讨论的结论是：先确认 ${i * 11} 号假设，再核对 ${i * 17} 号观测值，最后落到可执行的最小一步。`,
  )
  const prose = Array.from({ length: 12 }, () => pool.join('')).join('')

  const sameSentenceTwice = `${normal}${'另一个完全不同的收尾句子，只出现两次。'.repeat(2)}`

  // 400 行「有内容的行」但每行都不同：像一份长代码/长清单，绝不能误杀。
  const codeish = Array.from({ length: 900 }, (_, i) =>
    i % 7 === 1 ? '}' : `const value${i} = compute(${i * 13}, '${['alpha', 'beta', 'gamma'][i % 3]}')`).join('\n')

  const cases = [
    // [label, chunks, expectHit]
    ['数字递进的长清单 4 万字符', chunked(normal, 7), false],
    ['散文循环 12 轮', chunked(prose, 11), false],
    ['长代码样文本（每行不同）', chunked(codeish, 9), false],
    ['行级塌缩：6 种标记行刷屏', chunked('写。\n\n执行。\n\n**写 pwsh**。\n\n好，执行。\n\n好。\n\n**写**。\n\n'.repeat(3000), 8), true],
    ['一句话只重复两次', chunked(sameSentenceTwice, 7), false],
    ['单字标记 `写。` 刷屏', chunked('写。'.repeat(6000), 5), true],
    ['两行交替 `写。/执行。`', chunked('写。\n执行。\n'.repeat(4000), 6), true],
    ['180 字符段落重复 10 次', chunked(`${'好，执行。**写 pwsh**。执行。写。'.repeat(12)}\n`.repeat(10), 64), true],
    ['正文（text-delta）循环同样被抓', chunked('执行。'.repeat(6000), 4, 'text-delta'), true],
    ['工具调用参数不在管辖范围', chunked('写。'.repeat(6000), 4, 'tool-call-delta'), false],
    ['maxTotalChars 兜底', chunked(normal, 7), true, { maxTotalChars: 5000, probeChars: 4096, regionChars: 32768 }],
  ]

  let failed = 0
  for (const [label, chunks, expectHit, override] of cases) {
    const config = override ? resolveConfig(override) : cfg
    const { hit } = run(chunks, config)
    const ok = Boolean(hit) === expectHit
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: expect ${expectHit ? 'hit' : 'clear'}, got ${hit ? `${hit.reason}/${hit.kind}` : 'clear'}`)
  }

  // 窗口下限保护：regionChars 写小了必须被抬到 probeChars * minOccurrences。
  const clamped = resolveConfig({ probeChars: 200, regionChars: 256, minOccurrences: 5 })
  const clampOk = clamped.regionChars === 1000
  if (!clampOk) failed += 1
  console.log(`${clampOk ? 'ok  ' : 'FAIL'} regionChars 下限保护: ${clamped.regionChars}`)

  // 正常路径不能因为检测而改变分块顺序。
  const replay = async () => {
    const source = [{ type: 'block-start', index: 0, blockType: 'reasoning' }, ...chunked(normal, 7)]
    const stream = (async function* () { for (const c of source) yield c })()
    const seen = []
    for await (const c of guardStream({ warn: () => {} }, cfg, { provider: 'p', model: 'm' }, stream)) seen.push(c)
    return seen.length === source.length
  }
  let replayOk = false
  try {
    replayOk = await replay()
  } catch (error) {
    console.log(`      正常流被误杀：${error?.message ?? error}`)
  }
  if (!replayOk) failed += 1
  console.log(`${replayOk ? 'ok  ' : 'FAIL'} 正常流原样透传`)

  console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSelfTest()
}
