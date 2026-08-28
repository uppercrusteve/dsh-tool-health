// dsh-tool-health — 工具健康度哨兵（DSH host 端插件，v0.1.0，host-only，零 npm 依赖）
//
// 纪律（沿 dsh-converge 实测经验，违反 = 炸树）：
//   1. 只用 node: 内置 + Cordis ctx API；不 import 任何 npm 包。
//   2. inject 全有或全无：只 inject 实测 apply 期就绪的核心服务（tools/systemPrompt，
//      converge P2/W1 实测）；webServer/commands/sessions 在 apply 期可能缺席（W1 实测
//      apply 期 absent、起宿主 +2.5s present），一律 ctx.get + try/catch 惰性探测 + 退避重试。
//   3. 读 ctx 上不存在的属性会抛：能力探测全走 safeGet / try-catch。
//   4. 一切内部错误被吞：观测面任何异常绝不影响宿主工具执行。
//   5. 事件面以官方源码为准（本机 @deepseek-ai 包 grep 实测）：
//      - tools/result  mode=emit  纯观测（exec/result 冻结，监听器失败被宿主隔离）→ 记 {ok, errorClass}
//      - tools/execute mode=waterfall 官方 metrics 环绕钩子 (exec, next) → 计时 ms
//      （tools/post-execute 是决策 waterfall，须返回 next()/decision，纯观测用 tools/result 更稳。）
//
// 持久化：<DSH_HOME|~/.dsh>/tool-health/history.json
//   滚动窗口（每工具 windowDays 天、maxEntriesPerTool 条），写入防抖 ≥1s，tmp+rename 原子替换，
//   损坏文件改名备份后重建，不抛错。
//
// 配置：apply(ctx, config) 第二参（patch 行 config: 块）。不导出 config schema——
//   converge 教训：不要以 standard-schema 语义导出 Config。未识别键忽略。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-tool-health'
// headless+web 实测（converge P2/W1）就绪、且 apply 期同步就要用的最小集合。
export const inject = ['tools', 'systemPrompt']

const VERSION = '0.1.0'
const ROUTE_PREFIX = '/dsh-tool-health'
const SECTION_NAME = 'plugin:tool-health'
const SECTION_ORDER = 218
const ERR_EXCERPT = 240
const MAX_TOOLS = 200 // 内存/磁盘键数硬顶（异常场景防膨胀）
const MOUNT_SCHEDULE_MS = [0, 500, 1200, 2500, 5000, 10000, 20000, 40000]

export const DEFAULTS = Object.freeze({
  windowDays: 14,
  warnWindowDays: 3,
  warnMinFailures: 5,
  warnMinRate: 0.3,
  maxEntriesPerTool: 500,
  flushDebounceMs: 1000,
})

// ------------------------------------------------------------------ 纯函数（导出供测试）

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/** patch 行 config → 合并默认。只认白名单键，其他忽略；非法值回退默认。 */
function parseConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cfg = {
    windowDays: clampNum(src.windowDays, 1, 90, DEFAULTS.windowDays),
    warnWindowDays: clampNum(src.warnWindowDays, 1, 30, DEFAULTS.warnWindowDays),
    warnMinFailures: clampNum(src.warnMinFailures, 1, 10000, DEFAULTS.warnMinFailures),
    warnMinRate: clampNum(src.warnMinRate, 0, 1, DEFAULTS.warnMinRate),
    maxEntriesPerTool: Math.round(clampNum(src.maxEntriesPerTool, 50, 5000, DEFAULTS.maxEntriesPerTool)),
    flushDebounceMs: Math.round(clampNum(src.flushDebounceMs, 1000, 60000, DEFAULTS.flushDebounceMs)),
  }
  const recognized = ['windowDays', 'warnWindowDays', 'warnMinFailures', 'warnMinRate', 'maxEntriesPerTool', 'flushDebounceMs']
  const overridden = src && typeof raw === 'object' ? recognized.filter((k) => src[k] !== undefined) : []
  return { cfg, source: raw && typeof raw === 'object' && overridden.length ? 'patch' : raw && typeof raw === 'object' ? 'host-object(defaults)' : 'defaults', overridden }
}

/** DSH_HOME 优先；缺省回退 ~/.dsh。纯函数：env 与 home 显式传入。 */
function resolveHistoryPath(env, homeDir) {
  const base = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()
    ? env.DSH_HOME.trim()
    : path.join(homeDir || os.homedir(), '.dsh')
  return path.join(base, 'tool-health', 'history.json')
}

/** 从冻结的 result 里抽错误文本（error 字段 + text 内容块），≤400 字符。 */
function extractErrorText(result) {
  const parts = []
  try {
    const err = result?.error
    if (typeof err === 'string') parts.push(err)
    else if (err && typeof err === 'object') parts.push(String(err.message ?? err.code ?? JSON.stringify(err)))
  } catch { /* 忽略 */ }
  try {
    const content = result?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        try { if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text) } catch { /* 跳过 */ }
      }
    }
  } catch { /* 忽略 */ }
  const text = parts.filter(Boolean).join(' | ')
  return text.length > 400 ? text.slice(0, 400) : text
}

/** 错误分类（文本启发式，v0.1 保守）。ok → success；命中顺序 timeout→rate-limit→permission→network。 */
function errorClass(ok, errText) {
  if (ok) return 'success'
  const s = String(errText || '')
  if (/(timed?\s*out|timeout|etimedout|deadline exceeded)/i.test(s)) return 'timeout'
  if (/(rate.?limit|too many requests|\b429\b|quota|throttl)/i.test(s)) return 'rate-limit'
  if (/(permission|denied|unauthorized|forbidden|\b401\b|\b403\b|eacces|eperm|not allowed|approval|escalat)/i.test(s)) return 'permission'
  if (/(econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|socket hang up|network|getaddrinfo|fetch failed|proxy|econnaborted|connection (refused|closed|reset))/i.test(s)) return 'network'
  return 'unknown'
}

const isRecord = (r) => r && Number.isFinite(r.ts) && typeof r.ok === 'boolean'

/** 历史裁剪：每工具 ts ∈ [now-windowDays, ∞) 且 ≤maxEntries 条（新者优先）。返回统计。 */
function pruneHistory(buckets, { now, windowDays, maxEntriesPerTool }) {
  const minTs = now - windowDays * 86400000
  const stats = { droppedOld: 0, droppedCap: 0 }
  for ( const tool of Object.keys(buckets)) {
    let rows = Array.isArray(buckets[tool]) ? buckets[tool].filter(isRecord) : []
    const before = rows.length
    rows = rows.filter((r) => r.ts >= minTs)
    stats.droppedOld += before - rows.length
    if (rows.length > maxEntriesPerTool) {
      const overflow = rows.length - maxEntriesPerTool
      rows = rows.slice(overflow) // 保留最新
      stats.droppedCap += overflow
    }
    rows.sort((a, b) => a.ts - b.ts)
    if (rows.length) buckets[tool] = rows
    else delete buckets[tool]
  }
  return stats
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

/** 单工具窗口聚合：调用数/成功率/错误分布/p50/p95/最近一次失败。 */
function aggregateTool(records, { now, days }) {
  const minTs = now - days * 86400000
  const rows = (Array.isArray(records) ? records : []).filter((r) => isRecord(r) && r.ts >= minTs)
  const calls = rows.length
  const failures = rows.filter((r) => !r.ok).length
  const okMs = rows.filter((r) => r.ok && Number.isFinite(r.ms) && r.ms >= 0).map((r) => r.ms).sort((a, b) => a - b)
  const errorCounts = {}
  let lastFailure = null
  for (const r of rows) {
    if (!r.ok) {
      const ec = typeof r.errorClass === 'string' && r.errorClass ? r.errorClass : 'unknown'
      errorCounts[ec] = (errorCounts[ec] || 0) + 1
      if (!lastFailure || r.ts > lastFailure.ts) lastFailure = { ts: r.ts, errorClass: ec, err: typeof r.err === 'string' ? r.err.slice(0, 160) : '' }
    }
  }
  return {
    calls,
    successes: calls - failures,
    failures,
    failRate: calls ? failures / calls : 0,
    p50ms: percentile(okMs, 0.5),
    p95ms: percentile(okMs, 0.95),
    errorCounts,
    lastFailure,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
  }
}

/** 慢性失败工具判定：近 warnWindowDays 天失败 ≥warnMinFailures 且失败率 ≥warnMinRate。 */
function findChronic(buckets, { now, warnWindowDays, warnMinFailures, warnMinRate }) {
  const out = []
  for (const tool of Object.keys(buckets || {})) {
    const agg = aggregateTool(buckets[tool], { now, days: warnWindowDays })
    if (agg.failures >= warnMinFailures && agg.calls > 0 && agg.failRate >= warnMinRate) {
      out.push({ tool, calls: agg.calls, failures: agg.failures, failRate: agg.failRate })
    }
  }
  out.sort((a, b) => b.failRate - a.failRate || b.failures - a.failures || String(a.tool).localeCompare(String(b.tool)))
  return out
}

/** 系统提示注入行（规格固定格式）。chronic 为空 → 空串。 */
function warnLine(chronic) {
  if (!chronic || !chronic.length) return ''
  const list = chronic.map((c) => `${c.tool}(${Math.round(c.failRate * 100)}%)`).join(' ')
  return `⚠ tool-health: 近期高失败率工具 ${list}——优先改用替代或先检查其依赖服务。`
}

const fmtPct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
const fmtMs = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '-')

/** report markdown 表（工具/命令/HTTP 共用的同源渲染）。 */
function renderReport({ generatedAt, days, rows, toolFilter }) {
  const head = `# tool-health report（窗口 ${days}d，生成于 ${new Date(generatedAt).toISOString()}${toolFilter ? `，tool=${toolFilter}` : ''}）`
  if (!rows.length) return `${head}\n\n窗口内没有工具执行记录。（重试策略 v0.1：仅记录建议、不自动重试。）`
  const lines = [
    head,
    '',
    '| tool | calls | success | p50ms | p95ms | error mix | last failure |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const mix = Object.entries(r.errorCounts || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '-'
    const last = r.lastFailure ? `${new Date(r.lastFailure.ts).toISOString()} [${r.lastFailure.errorClass}] ${String(r.lastFailure.err || '').replace(/\|/g, '/').slice(0, 80) || '(no text)'}` : '-'
    lines.push(`| ${r.tool} | ${r.calls} | ${fmtPct(1 - r.failRate)} | ${fmtMs(r.p50ms)} | ${fmtMs(r.p95ms)} | ${mix} | ${last} |`)
  }
  const chronic = rows.filter((r) => r.failures >= 5 && r.failRate >= 0.3)
  lines.push('', `重试策略 v0.1：observe-only（仅记录建议，不自动重试）。${chronic.length ? `高失败：${chronic.map((c) => `${c.tool}(${fmtPct(c.failRate)})`).join(' ')}` : ''}`)
  return lines.join('\n')
}

/** 入库前净化：只保留白名单字段与有限数值。 */
function jsonableRecord(rec) {
  return {
    ts: Number.isFinite(rec?.ts) ? Math.round(rec.ts) : Date.now(),
    ok: rec?.ok === true,
    ms: Number.isFinite(rec?.ms) && rec.ms >= 0 ? Math.round(rec.ms) : null,
    errorClass: typeof rec?.errorClass === 'string' && rec.errorClass ? rec.errorClass.slice(0, 32) : 'unknown',
    ...(typeof rec?.err === 'string' && rec.err ? { err: rec.err.slice(0, ERR_EXCERPT) } : {}),
  }
}

export const pure = {
  parseConfig, resolveHistoryPath, extractErrorText, errorClass,
  pruneHistory, aggregateTool, findChronic, warnLine, renderReport,
  jsonableRecord, percentile, clampNum,
}

// ------------------------------------------------------------------ 插件 apply
// 重要（真机实测教训）：cordis 会把插件 apply 的返回值当作 effect 收集——
// 返回非 function/null/thenable/iterable 的对象会抛 "Invalid effect" 直接炸树。
// 因此 apply 必须不返回任何值；运行时句柄只挂 ctx.__toolHealth（离线测试用）。
export async function apply (ctx, config) {
  try {
    applyInner(ctx, config)
  } catch (e) {
    try { console.log(`[tool-health] apply FAILED ${String((e && e.message) || e)}`) } catch { /* noop */ }
  }
}

function applyInner(ctx, config) {
  const { cfg, source: configSource, overridden } = parseConfig(config)
  const historyPath = resolveHistoryPath(process.env, os.homedir())
  const services = { tools: 'yes', systemPrompt: 'yes', commands: 'pending', webServer: 'pending', sessions: 'pending' }
  const mounted = { commands: false, webServer: false }
  const counters = { seen: 0, recorded: 0, writes: 0, writeFail: 0, mountAttempts: 0 }

  const logFile = typeof process.env.DSH_TOOLHEALTH_LOG === 'string' && process.env.DSH_TOOLHEALTH_LOG ? process.env.DSH_TOOLHEALTH_LOG : null
  const jlog = (ev, fields) => {
    if (!logFile) return
    try { fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), plugin: 'dsh-tool-health', ev, ...fields }) + '\n') } catch { /* 取证日志不影响主流程 */ }
  }

  // ---- 持久化 ----
  let buckets = {} // tool -> records[]
  let corruptNote = null
  const readDisk = () => {
    try {
      const raw = fs.readFileSync(historyPath, 'utf8')
      const doc = JSON.parse(raw)
      if (!doc || typeof doc !== 'object' || typeof doc.tools !== 'object' || doc.tools === null) throw new Error('schema mismatch')
      const out = {}
      for (const t of Object.keys(doc.tools)) {
        const rows = Array.isArray(doc.tools[t]) ? doc.tools[t].filter(isRecord).map(jsonableRecord) : []
        if (rows.length) out[String(t).slice(0, 120)] = rows
      }
      return { buckets: out, corrupt: false }
    } catch (e) {
      const code = e && e.code
      if (code === 'ENOENT') return { buckets: {}, corrupt: false }
      // 损坏：备份改名后重建，绝不抛
      try {
        const bak = `${historyPath}.corrupt-${Date.now()}`
        fs.renameSync(historyPath, bak)
        return { buckets: {}, corrupt: `recovered-corrupt -> ${path.basename(bak)}` }
      } catch {
        try { fs.unlinkSync(historyPath) } catch { /* noop */ }
        return { buckets: {}, corrupt: 'recovered-corrupt-unlinked' }
      }
    }
  }
  const disk = readDisk()
  buckets = disk.buckets
  corruptNote = disk.corrupt

  const pruneNow = () => pure.pruneHistory(buckets, { now: Date.now(), windowDays: cfg.windowDays, maxEntriesPerTool: cfg.maxEntriesPerTool })
  pruneNow()

  let flushTimer = null
  let lastWrite = 0
  let dirty = false
  const writeNow = (force) => {
    try {
      if (!force && !dirty) return
      const doc = {
        plugin: 'dsh-tool-health', version: 1, historyVersion: 1,
        updatedAt: new Date().toISOString(),
        windowDays: cfg.windowDays, maxEntriesPerTool: cfg.maxEntriesPerTool,
        tools: buckets,
      }
      fs.mkdirSync(path.dirname(historyPath), { recursive: true })
      const tmp = `${historyPath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc))
      try {
        fs.renameSync(tmp, historyPath)
      } catch (e) {
        // Windows 偶发 EPERM：目标可能瞬时被占，重试一次
        try { fs.unlinkSync(historyPath) } catch { /* noop */ }
        fs.renameSync(tmp, historyPath)
      }
      dirty = false
      lastWrite = Date.now()
      counters.writes++
    } catch (e) {
      counters.writeFail++
      jlog('write-failed', { message: String((e && e.message) || e).slice(0, 200), path: historyPath })
    }
  }
  const scheduleFlush = () => {
    dirty = true
    if (flushTimer) return
    const wait = Math.max(0, cfg.flushDebounceMs - (Date.now() - lastWrite))
    flushTimer = setTimeout(() => { flushTimer = null; writeNow(false) }, wait)
    if (typeof flushTimer?.unref === 'function') flushTimer.unref()
  }
  process.on('exit', () => { try { writeNow(true) } catch { /* noop */ } })

  // ---- 观测：tools/execute 计时 + tools/result 记录（官方事件面，grep 实测签名） ----
  const timings = new Map() // callId -> t0
  try {
    const off = ctx.on?.('tools/execute', async (exec, next) => {
      try { if (exec && exec.callId != null) timings.set(String(exec.callId), Date.now()) } catch { /* 计时失败不拦调用 */ }
      return await next()
    })
    if (typeof off === 'function') ctx.effect?.(() => off)
    services.toolsExecute = 'on'
  } catch (e) { services.toolsExecute = 'failed'; jlog('event-subscribe-failed', { event: 'tools/execute', message: String((e && e.message) || e) }) }

  // 记录一次已落定的工具执行（tools/result 监听器与离线测试共用同一路径）
  const observe = (exec, result) => {
    try {
      counters.seen++
      const toolName = String(exec?.name ?? 'unknown').slice(0, 120)
      let ms = null
      try {
        if (exec?.callId != null && timings.has(String(exec.callId))) {
          ms = Date.now() - timings.get(String(exec.callId))
          timings.delete(String(exec.callId))
        }
      } catch { /* ms 可选 */ }
      if (timings.size > 500) { // 泄漏兜底：丢老条目
        const cutoff = Date.now() - 600000
        for (const [k, t0] of timings) if (t0 < cutoff) timings.delete(k)
      }
      const ok = !(result && result.isError === true)
      const errText = ok ? '' : extractErrorText(result)
      const rec = jsonableRecord({ ts: Date.now(), ok, ms, errorClass: errorClass(ok, errText), err: ok ? '' : errText.slice(0, ERR_EXCERPT) })
      const arr = buckets[toolName] || (buckets[toolName] = [])
      if (arr.length >= cfg.maxEntriesPerTool * 2) buckets[toolName] = arr = arr.slice(-cfg.maxEntriesPerTool)
      arr.push(rec)
      if (Object.keys(buckets).length > MAX_TOOLS) {
        // 工具名爆炸（异常场景）：裁掉最旧
        const oldest = Object.keys(buckets).sort((a, b) => (buckets[a].at(-1)?.ts ?? 0) - (buckets[b].at(-1)?.ts ?? 0))[0]
        if (oldest && oldest !== toolName) delete buckets[oldest]
      }
      counters.recorded++
      pruneNow()
      scheduleFlush()
    } catch { /* 观测绝不影响宿主 */ }
  }

  try {
    const off = ctx.on?.('tools/result', (exec, result) => observe(exec, result))
    if (typeof off === 'function') ctx.effect?.(() => off)
    services.toolsResult = 'on'
  } catch (e) { services.toolsResult = 'failed'; jlog('event-subscribe-failed', { event: 'tools/result', message: String((e && e.message) || e) }) }

  // ---- 聚合 / 报告 ----
  const reportRows = (days, toolFilter) => {
    const now = Date.now()
    const names = Object.keys(buckets).filter((t) => !toolFilter || t === toolFilter)
    const rows = names.map((t) => ({ tool: t, ...aggregateTool(buckets[t], { now, days }) }))
      .filter((r) => r.calls > 0)
      .sort((a, b) => b.calls - a.calls || String(a.tool).localeCompare(String(b.tool)))
    return rows
  }
  const buildReport = (args) => {
    const days = pure.clampNum(args?.days, 1, 90, 7)
    const toolFilter = typeof args?.tool === 'string' && args.tool ? args.tool : null
    const rows = reportRows(days, toolFilter)
    const markdown = renderReport({ generatedAt: Date.now(), days, rows, toolFilter })
    const chronic = findChronic(buckets, { now: Date.now(), warnWindowDays: cfg.warnWindowDays, warnMinFailures: cfg.warnMinFailures, warnMinRate: cfg.warnMinRate })
    return { ok: true, days, toolFilter, retryPolicy: 'v0.1-observe-only', chronic, rows, markdown }
  }
  const summaryJson = () => {
    const now = Date.now()
    const rows = reportRows(7, null)
    return {
      plugin: 'dsh-tool-health', version: VERSION, generatedAt: new Date(now).toISOString(),
      reportWindowDays: 7, config: cfg, historyPath,
      counters: { ...counters }, corruptRecovery: corruptNote,
      chronic: findChronic(buckets, { now, warnWindowDays: cfg.warnWindowDays, warnMinFailures: cfg.warnMinFailures, warnMinRate: cfg.warnMinRate }),
      retryPolicy: 'v0.1-observe-only',
      tools: Object.fromEntries(rows.map((r) => [r.tool, r])),
    }
  }

  // ---- 模型工具（注册形态照 converge 实测：ctx.tools.register({name, description, parameters, output, execute})） ----
  const registerTool = (def) => {
    try {
      ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: typeof value?.markdown === 'string' ? value.markdown : JSON.stringify(value) }],
        },
        execute: async (args) => {
          try { return jsonableOut(def.run(args ?? {})) } catch (e) {
            return jsonableOut({ ok: false, error: String((e && e.message) || e).slice(0, 300) })
          }
        },
      })
    } catch (e) { jlog('tool-register-failed', { tool: def.name, message: String((e && e.message) || e) }) }
  }
  // 出参净化：rows 里塞回 markdown 之外的普通对象即可（都已是基础类型），整体限深防抖
  const jsonableOut = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch { return { ok: false, error: 'unserializable' } } }

  registerTool({
    name: 'tool_health_report',
    description: '工具执行健康度体检报告（近 N 天，默认 7）：每工具调用数/成功率/错误分布/p50/p95 延迟/最近失败。可选 {tool, days}。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '只看某个工具名（可选，精确匹配）' },
        days: { type: 'number', description: '窗口天数 1..90，默认 7' },
      },
      additionalProperties: false,
    },
    run: (args) => buildReport(args),
  })

  registerTool({
    name: 'tool_health_reset',
    description: '清空工具健康度历史（需 confirm:true 防误删）。返回被清除的记录数。',
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: '必须显式传 true' } },
      additionalProperties: false,
    },
    run: (args) => {
      if (args?.confirm !== true) return { ok: false, error: 'confirm:true required (refusing to clear without explicit confirmation)' }
      let cleared = 0
      for (const t of Object.keys(buckets)) { cleared += buckets[t].length; delete buckets[t] }
      try { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null } } catch { /* noop */ }
      dirty = false
      writeNow(true)
      return { ok: true, cleared, historyPath }
    },
  })

  // ---- 系统提示注入（section 注册面照 converge 实测：ctx.systemPrompt.section({name, order, text})） ----
  const chronicAtBoot = findChronic(buckets, { now: Date.now(), warnWindowDays: cfg.warnWindowDays, warnMinFailures: cfg.warnMinFailures, warnMinRate: cfg.warnMinRate })
  const warnText = warnLine(chronicAtBoot)
  let sectionOutcome = 'ok'
  try {
    ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: warnText })
  } catch (e) {
    sectionOutcome = `failed-empty-fallback`
    try { ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: '' }) } catch { sectionOutcome = 'failed' }
    jlog('section-failed', { message: String((e && e.message) || e).slice(0, 200) })
  }
  jlog('section-registered', { outcome: sectionOutcome, chronic: chronicAtBoot.length, textPreview: warnText.slice(0, 160) })

  // ---- 惰性挂载 commands / webServer / sessions（apply 期可能缺席，退避重试，不炸树） ----
  const safeGet = (svc) => { try { const s = ctx.get ? ctx.get(svc) : ctx[svc]; return s ?? null } catch { return null } }

  const tryMountCommands = () => {
    if (mounted.commands) return true
    const cmd = safeGet('commands')
    if (!cmd || typeof cmd.register !== 'function') return false
    try {
      const dispose = cmd.register({
        name: 'tool-health',
        description: 'print the tool-health digest for the last 7 days (same source as tool_health_report)',
        handler: () => {
          try { return { kind: 'success', text: buildReport({ days: 7 }).markdown } } catch (e) {
            return { kind: 'error', text: `tool-health: ${String((e && e.message) || e)}` }
          }
        },
      })
      if (typeof dispose === 'function' && ctx.effect) { try { ctx.effect(() => () => { try { dispose() } catch { /* noop */ } }) } catch { /* noop */ } }
      mounted.commands = true
      services.commands = 'mounted'
      jlog('command-mounted', { name: '/tool-health' })
      console.log('[tool-health] command /tool-health mounted')
      return true
    } catch (e) { jlog('command-mount-failed', { message: String((e && e.message) || e).slice(0, 160) }); return false }
  }

  const tryMountWebServer = () => {
    if (mounted.webServer) return true
    const ws = safeGet('webServer')
    if (!ws || typeof ws.register !== 'function') return false
    try {
      const dispose = ws.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          try {
            const method = String(req?.method || '').toUpperCase()
            const u = new URL(String(req?.url || '/'), 'http://127.0.0.1')
            const sub = u.pathname.slice(ROUTE_PREFIX.length) || '/'
            if (method !== 'GET' && method !== 'HEAD') {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'method not allowed' }))
              return
            }
            if (sub === '/summary' || sub === '/summary/') {
              const body = JSON.stringify(summaryJson())
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(body)
              jlog('summary-served', { bytes: body.length })
              return
            }
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'not found', hint: `try GET ${ROUTE_PREFIX}/summary` }))
          } catch (e) {
            try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) })) } catch { /* noop */ }
          }
        },
      })
      if (typeof dispose === 'function' && ctx.effect) { try { ctx.effect(() => () => { try { dispose() } catch { /* noop */ } }) } catch { /* noop */ } }
      mounted.webServer = true
      services.webServer = 'mounted'
      jlog('route-mounted', { prefix: ROUTE_PREFIX })
      console.log(`[tool-health] route ${ROUTE_PREFIX}/summary mounted`)
      return true
    } catch (e) { jlog('route-mount-failed', { message: String((e && e.message) || e).slice(0, 160) }); return false }
  }

  const probeSessions = () => {
    const s = safeGet('sessions')
    services.sessions = s ? 'present' : 'absent'
    return !!s
  }

  const mountAll = () => {
    counters.mountAttempts++
    if (!mounted.commands) tryMountCommands()
    if (!mounted.webServer) tryMountWebServer()
    if (services.sessions === 'pending') probeSessions()
    return mounted.commands && mounted.webServer && services.sessions !== 'pending'
  }

  // 立即试一次，缺席则按 MOUNT_SCHEDULE 退避重试
  try {
    if (!mountAll()) {
      for (const ms of MOUNT_SCHEDULE_MS) {
        if (ms === 0) continue
        const t = setTimeout(() => { try { mountAll() } catch { /* noop */ } }, ms)
        if (typeof t?.unref === 'function') t.unref()
      }
    }
  } catch (e) { jlog('mount-crash', { message: String((e && e.message) || e) }) }

  // ---- boot 日志（一行结构化，runner grep '[tool-health] apply ok' 作判定） ----
  const toolsSeen = Object.keys(buckets).length
  const bootLine = `[tool-health] apply ok v=${VERSION} windowDays=${cfg.windowDays} warnWindowDays=${cfg.warnWindowDays} warnMinFailures=${cfg.warnMinFailures} warnMinRate=${cfg.warnMinRate} maxEntriesPerTool=${cfg.maxEntriesPerTool} toolsSeen=${toolsSeen} chronic=${chronicAtBoot.length} configSource=${configSource}${overridden.length ? `(${overridden.join('+')})` : ''} section=${sectionOutcome} services=tools:yes,systemPrompt:yes,commands:${mounted.commands ? 'mounted' : services.commands},webServer:${mounted.webServer ? 'mounted' : services.webServer},sessions:${services.sessions} history=${historyPath}${corruptNote ? ' (corrupt-recovered)' : ''}`
  console.log(bootLine)
  jlog('apply-ok', {
    version: VERSION, cfg, configSource, overridden, toolsSeen,
    chronic: chronicAtBoot.map((c) => `${c.tool}:${Math.round(c.failRate * 100)}%`),
    services: { ...services }, sectionOutcome, corruptNote,
    events: { toolsExecute: 'on', toolsResult: services.toolsResult || 'on' },
    historyPath,
  })
  process.env.DSH_TOOLHEALTH_BOOT_LINE = bootLine // 离线测试/取证便捷面（可忽略）

  // 测试钩子：假 ctx 直接驱动观测与挂载（宿主不读这个属性）
  try {
    ctx.__toolHealth = {
      cfg, buckets, counters, services, mounted, summaryJson, buildReport, observe,
      bootLine,
      mount: { commands: tryMountCommands, webServer: tryMountWebServer },
      writeNow: () => writeNow(true),
    }
  } catch { /* ctx 冻结也不影响 */ }
}
