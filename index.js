import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { maybeImportHistory } from './migrate.js'

export const API_PATH = '/dsh-balance-panel/api/state'

const OFFICIAL_PRICES = {
  'deepseek-flash': {
    idle: { hit: 0.02, miss: 1, out: 4 },
    peak: { hit: 0.04, miss: 2, out: 8 },
  },
  'deepseek-v4-pro': {
    idle: { hit: 0.15, miss: 4.5, out: 13.5 },
    peak: { hit: 0.3, miss: 9, out: 27 },
  },
}

const ACCOUNT_MEMO_MS = 45000
const DAILY_MEMO_MS = 30000
const SESSION_CACHE_STALE_MS = 90000
const HISTORY_DAYS = 7
const MAX_SESSIONS = 40
const READ_CONCURRENCY = 3

export function apply(ctx, config) {
  const controller = createController(ctx, config)
  controller.log('info', 'balance widget host half active')

  const attach = (webCtx) => {
    try {
      registerRoute(webCtx, controller)
    } catch (error) {
      controller.log('warn', `could not register ${API_PATH}: ${describe(error)}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach)
    else attach(ctx)
  } catch {
    attach(ctx)
  }

  const importOnce = () => maybeImportHistory(ctx, controller).catch((error) => {
    controller.log('warn', `history import failed: ${describe(error)}`)
  })
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['workspaceRegistry'], importOnce)
    else importOnce()
  } catch {
    importOnce()
  }
}

function createController(ctx, config) {
  return {
    ctx,
    prices: mergePrices(config?.prices),
    ring: [],
    log(level, text) {
      const line = `${new Date().toISOString()} ${level} ${text}`
      this.ring.push(line)
      if (this.ring.length > 80) this.ring.shift()
      try {
        ctx.logger?.('dsh-balance-panel')?.[level === 'warn' ? 'warn' : 'info']?.(text)
      } catch {}
    },
    account: undefined,
    daily: undefined,
    sessions: new Map(),
    snapshotPending: undefined,
    diagnosePending: undefined,
  }
}

function mergePrices(overrides) {
  const merged = clone(OFFICIAL_PRICES)
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return merged

  for (const [model, entry] of Object.entries(overrides)) {
    if (!model || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (!merged[model]) {
      if (validTier(entry.idle) && validTier(entry.peak)) {
        merged[model] = { idle: clone(entry.idle), peak: clone(entry.peak) }
      }
      continue
    }
    for (const tier of ['idle', 'peak']) {
      const candidate = entry[tier]
      if (!candidate || typeof candidate !== 'object') continue
      for (const key of ['hit', 'miss', 'out']) {
        if (Number.isFinite(candidate[key]) && candidate[key] >= 0) merged[model][tier][key] = candidate[key]
      }
    }
  }
  return merged
}

function validTier(value) {
  return value && typeof value === 'object' && ['hit', 'miss', 'out'].every((key) => Number.isFinite(value[key]) && value[key] >= 0)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function handle(request, response, controller) {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
      return
    }
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { error: 'local access only' })
      return
    }

    const url = new URL(request.url ?? API_PATH, 'http://localhost')
    const debug = url.searchParams.get('debug') === '1'
    const diagnose = url.searchParams.get('diagnose') === '1'
    if (diagnose) {
      const sessions = await sharedDiagnosis(controller)
      sendJson(response, 200, { at: Date.now(), sessions })
      return
    }

    const payload = await snapshot(controller)
    const body = debug ? {
      ...payload,
      debug: {
        log: [...controller.ring],
        services: {
          deepseekAccount: has(controller.ctx, 'deepseekAccount'),
          sessionQuery: has(controller.ctx, 'sessionQuery'),
          sessions: has(controller.ctx, 'sessions'),
        },
        cachedSessions: controller.sessions.size,
        clientModules: describeClientModules(controller.ctx),
      },
    } : payload
    sendJson(response, 200, body)
  } catch (error) {
    controller.log('warn', `request failed: ${describe(error)}`)
    try {
      sendJson(response, 500, { error: describe(error) })
    } catch {}
  }
}

function isLocalRequest(request) {
  const address = request.socket?.remoteAddress ?? request.connection?.remoteAddress
  if (typeof address !== 'string' || !(address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'))) return false

  try {
    const host = request.headers?.host
    if (typeof host !== 'string' || !isLoopbackHostname(new URL(`http://${host}`).hostname)) return false
    const origin = request.headers?.origin
    if (origin !== undefined) {
      if (typeof origin !== 'string') return false
      const parsed = new URL(origin)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLoopbackHostname(parsed.hostname)) return false
    }
    return true
  } catch {
    return false
  }
}

function isLoopbackHostname(value) {
  const hostname = String(value).toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost') return true
  const family = isIP(hostname)
  if (family === 4) {
    const octets = hostname.split('.').map(Number)
    return octets.length === 4 && octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255)
  }
  if (family === 6) return hostname === '::1' || hostname === '0:0:0:0:0:0:0:1'
  return false
}

function has(ctx, name) {
  try {
    return ctx.get?.(name) !== undefined
  } catch {
    return false
  }
}

function describeClientModules(ctx) {
  try {
    const modules = service(ctx, 'clientModules')
    const graph = modules?.graph?.()
    if (!graph) return { available: false }
    const entries = Array.isArray(graph.entries) ? graph.entries : []
    const batches = Array.isArray(graph.batches) ? graph.batches : []
    const rows = entries.filter((row) => String(row?.id ?? '').includes('dsh-balance-panel'))
    return {
      available: true,
      rev: graph.rev ?? null,
      entries: entries.length,
      batches: batches.length,
      rows: rows.map((row) => ({
        id: row.id,
        rev: row.rev ?? null,
        url: row.url ?? null,
        external: Array.isArray(row.external) ? row.external : [],
        immediately: row.immediately === true,
      })),
    }
  } catch (error) {
    return { available: false, error: describe(error) }
  }
}

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

function snapshot(controller) {
  if (controller.snapshotPending) return controller.snapshotPending
  const pending = buildSnapshot(controller).finally(() => {
    if (controller.snapshotPending === pending) controller.snapshotPending = undefined
  })
  controller.snapshotPending = pending
  return pending
}

async function buildSnapshot(controller) {
  const now = Date.now()
  const account = await readAccount(controller, now)
  const usage = await readUsage(controller, now)
  return {
    at: now,
    account,
    today: usage.today,
    history: usage.history,
    conversations: usage.today.conversations,
    prices: {
      source: 'DeepSeek 官方价目表（元 / 百万 tokens，峰谷两档）',
      models: Object.keys(controller.prices),
      estimated: true,
    },
  }
}

function sharedDiagnosis(controller) {
  if (controller.diagnosePending) return controller.diagnosePending
  const pending = diagnoseSessions(controller).finally(() => {
    if (controller.diagnosePending === pending) controller.diagnosePending = undefined
  })
  controller.diagnosePending = pending
  return pending
}

async function diagnoseSessions(controller) {
  const query = service(controller.ctx, 'sessionQuery')
  if (typeof query?.listSessions !== 'function') {
    return [{ id: null, ok: false, error: 'sessionQuery is unavailable in this profile' }]
  }
  let list
  try {
    list = await query.listSessions()
  } catch (error) {
    return [{ id: null, ok: false, error: `listSessions failed: ${describe(error)}` }]
  }
  const out = []
  for (const record of Array.isArray(list) ? list : []) {
    const id = recordId(record)
    if (!id) continue
    const header = record.header ?? {}
    const item = {
      id,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt ?? null,
      live: record.live === true,
      persisted: record.persisted === true,
      formatStatus: record.formatStatus ?? null,
    }
    try {
      const loaded = await query.readSession(id)
      const events = loaded?.events ?? []
      item.ok = true
      item.events = events.length
      item.types = countEventTypes(events)
      item.title = await readTitleSafe(query, id)
      if (typeof query.readSurface === 'function') {
        const surface = await query.readSurface(id)
        item.surface = Array.isArray(surface?.messages) ? surface.messages.length : true
      }
    } catch (error) {
      item.ok = false
      item.error = describe(error)
    }
    out.push(item)
  }
  return out
}

function countEventTypes(events) {
  const types = {}
  for (const event of events) {
    const type = typeof event?.type === 'string' ? event.type : 'unknown'
    types[type] = (types[type] ?? 0) + 1
  }
  return types
}

async function readTitleSafe(query, id) {
  try {
    const value = typeof query?.readTitle === 'function' ? await query.readTitle(id) : undefined
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value?.title === 'string' && value.title.length > 0) return value.title
  } catch {}
  return null
}

async function readAccount(controller, now) {
  const memo = controller.account
  if (memo && now - memo.at < ACCOUNT_MEMO_MS) return memo.value

  const value = { signedIn: false, currency: 'CNY', balance: null, recharge: null, bonus: null, links: null, error: null }
  try {
    const account = service(controller.ctx, 'deepseekAccount')
    if (!account) {
      value.error = 'account service unavailable'
    } else {
      const state = await account.getState?.()
      value.signedIn = state?.status === 'credential-stored'
      value.links = state?.links ?? null
      if (value.signedIn) {
        const client = {
          version: process.env.DSH_CLIENT_VERSION ?? '1.0.0',
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }
        const balance = typeof account.getBalance === 'function' ? await account.getBalance(client) : null
        if (balance?.status === 'ready') {
          const wallets = Array.isArray(balance.value) ? balance.value : []
          const bonuses = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
          value.currency = wallets[0]?.currency ?? bonuses[0]?.currency ?? 'CNY'
          value.recharge = sumWallets(wallets)
          value.bonus = sumWallets(bonuses)
          value.balance = round(value.recharge + value.bonus)
        } else {
          value.error = 'balance query failed'
        }
      }
    }
  } catch (error) {
    value.error = describe(error)
    controller.log('warn', `balance read failed: ${value.error}`)
  }

  controller.account = { at: now, value }
  return value
}

function sumWallets(wallets) {
  let total = 0
  for (const wallet of wallets) {
    const amount = Number.parseFloat(wallet?.balance ?? '')
    if (Number.isFinite(amount)) total += amount
  }
  return round(total)
}

async function readUsage(controller, now) {
  if (controller.daily && now - controller.daily.at < DAILY_MEMO_MS) return controller.daily.value

  const todayStart = startOfDay(now)
  const historyStart = shiftDays(todayStart, -(HISTORY_DAYS - 1))
  const today = { ...emptyAggregate(), sessions: 0, conversations: [] }
  const historyAll = emptyAggregate()
  const historyDays = new Map()
  for (let offset = 0; offset < HISTORY_DAYS; offset += 1) {
    const start = shiftDays(historyStart, offset)
    historyDays.set(start, emptyAggregate())
  }

  const query = service(controller.ctx, 'sessionQuery')
  const sessions = service(controller.ctx, 'sessions')
  const live = new Set()
  let listFailed = false
  let records = []

  try {
    for (const session of sessions?.list?.() ?? []) {
      const id = String(session?.id ?? '')
      if (id) live.add(id)
    }
  } catch {}

  try {
    const list = typeof query?.listSessions === 'function' ? await query.listSessions() : []
    records = Array.isArray(list) ? list : []
    if (typeof query?.listSessions !== 'function' && live.size === 0) listFailed = true
  } catch (error) {
    listFailed = true
    controller.log('warn', `session list failed: ${describe(error)}`)
  }

  const seen = new Set()
  const candidates = []
  const mtimes = sessionMtimes()
  for (const record of records) {
    const id = recordId(record)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const liveNow = record?.live === true || live.has(id)
    const created = recordStamp(record)
    const mtime = mtimes.get(id)
    const stamp = mtime ?? created
    // header.createdAt cannot prove inactivity: a session created last month
    // can still receive events today. Prefer the log file's mtime, and only
    // skip when both signals agree that the session is older than the window.
    if (!liveNow && mtime !== undefined && mtime < historyStart && (created === null || created < historyStart)) continue
    candidates.push({ id, liveNow, stamp: stamp ?? 0 })
  }
  for (const id of live) {
    if (seen.has(id)) continue
    seen.add(id)
    candidates.push({ id, liveNow: true, stamp: now })
  }
  candidates.sort((a, b) => Number(b.liveNow) - Number(a.liveNow) || b.stamp - a.stamp)

  const selected = candidates.slice(0, MAX_SESSIONS)
  const folds = await mapLimit(selected, READ_CONCURRENCY, async (item) => {
    try {
      return await sessionFold(controller, query, sessions, item.id, item.liveNow, now)
    } catch (error) {
      controller.log('warn', `could not fold ${item.id}: ${describe(error)}`)
      return { id: item.id, title: null, model: null, days: new Map(), error: describe(error) }
    }
  })

  let failures = 0
  for (const fold of folds) {
    if (fold.error) failures += 1
    const bucket = fold.days.get(todayStart)
    if (bucket) {
      mergeAggregate(today, bucket)
      today.sessions += 1
      today.conversations.push({
        id: fold.id,
        title: fold.title ?? null,
        model: bucket.model ?? fold.model ?? null,
        cost: round(bucket.cost),
        calls: bucket.calls,
        lastAt: bucket.lastAt,
        tokens: tokenSummary(bucket),
      })
    }
    for (const [day, bucket] of fold.days) {
      const target = historyDays.get(day)
      if (!target) continue
      mergeAggregate(target, bucket)
      mergeAggregate(historyAll, bucket)
    }
  }

  const complete = !listFailed && failures === 0 && selected.length === candidates.length
  today.conversations.sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)
  const todayValue = {
    ...metricSummary(today),
    sessions: today.sessions,
    since: todayStart,
    complete,
    delta: null,
    conversations: today.conversations.slice(0, MAX_SESSIONS),
    models: serializeModels(today.models),
  }
  const days = [...historyDays].map(([start, bucket]) => ({
    day: localDayKey(start),
    start,
    ...metricSummary(bucket),
  }))
  const history = {
    since: historyStart,
    days,
    total: metricSummary(historyAll),
    averageCost: round(historyAll.cost / HISTORY_DAYS),
    activeDays: days.filter((day) => day.calls > 0).length,
    models: serializeModels(historyAll.models),
    complete,
  }
  todayValue.delta = recordBalanceSnapshot(controller, todayValue, now)

  const value = { today: todayValue, history }
  controller.daily = { at: now, value }
  return value
}

function emptyAggregate() {
  return {
    cost: 0,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    lastAt: 0,
    model: null,
    models: {},
  }
}

function mergeAggregate(target, source) {
  target.cost += source.cost
  target.calls += source.calls
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reasoning += source.reasoning
  target.lastAt = Math.max(target.lastAt, source.lastAt)
  if (source.model) target.model = source.model
  for (const [model, stats] of Object.entries(source.models ?? {})) {
    const bucket = target.models[model] ?? (target.models[model] = emptyModelAggregate())
    mergeModelAggregate(bucket, stats)
  }
}

function emptyModelAggregate() {
  return { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function mergeModelAggregate(target, source) {
  target.cost += source.cost
  target.calls += source.calls
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reasoning += source.reasoning
}

function metricSummary(bucket) {
  return {
    cost: round(bucket.cost),
    calls: bucket.calls,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    tokens: tokenSummary(bucket),
  }
}

function tokenSummary(bucket) {
  return {
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    total: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
  }
}

function serializeModels(models) {
  return Object.entries(models)
    .map(([model, bucket]) => ({ model, ...metricSummary(bucket) }))
    .sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)
}

async function sessionFold(controller, query, sessions, id, liveNow, now) {
  let revision = 'persisted'
  if (liveNow) {
    try {
      revision = String(sessions?.get?.(id)?.seq ?? 'live')
    } catch {}
  }
  const cached = controller.sessions.get(id)
  if (cached && cached.revision === revision && now - cached.at < SESSION_CACHE_STALE_MS) return cached.value

  const days = new Map()
  const events = []
  let readError = null
  try {
    if (typeof query?.readSession === 'function') {
      const snapshot = await query.readSession(id)
      if (Array.isArray(snapshot?.events)) events.push(...snapshot.events)
    } else if (!liveNow) {
      readError = new Error('sessionQuery is unavailable')
    }
  } catch (error) {
    readError = error
    if (!liveNow) controller.log('info', `could not read ${id}: ${describe(error)}`)
  }
  if (events.length === 0 && liveNow) {
    try {
      for (const event of sessions?.get?.(id)?.ownEvents?.() ?? []) events.push(event)
    } catch (error) {
      readError ??= error
    }
  }

  let model = null
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const routeModel = event.data?.message?.source?.model
    if (typeof routeModel === 'string' && routeModel.length > 0) model = routeModel

    const time = Number.isFinite(event.time) ? event.time : now
    const day = startOfDay(time)
    const bucket = days.get(day) ?? emptyAggregate()
    const amount = cost(usage, priceOf(controller.prices, model, time))
    const output = count(usage.outputTokens) + count(usage.reasoningTokens)
    const modelName = model ?? 'unknown'
    const modelBucket = bucket.models[modelName] ?? (bucket.models[modelName] = emptyModelAggregate())

    bucket.cost += amount
    bucket.calls += 1
    bucket.input += count(usage.inputTokens)
    bucket.output += output
    bucket.cacheRead += count(usage.cacheReadTokens)
    bucket.cacheWrite += count(usage.cacheWriteTokens)
    bucket.reasoning += count(usage.reasoningTokens)
    bucket.lastAt = Math.max(bucket.lastAt, time)
    if (model) bucket.model = model

    modelBucket.cost += amount
    modelBucket.calls += 1
    modelBucket.input += count(usage.inputTokens)
    modelBucket.output += output
    modelBucket.cacheRead += count(usage.cacheReadTokens)
    modelBucket.cacheWrite += count(usage.cacheWriteTokens)
    modelBucket.reasoning += count(usage.reasoningTokens)
    days.set(day, bucket)
  }

  const title = await readTitleSafe(query, id)
  const value = {
    id,
    title,
    model,
    days,
    error: readError && events.length === 0 ? describe(readError) : null,
  }
  controller.sessions.set(id, { revision, at: now, value })
  return value
}

function cost(usage, price) {
  if (!price) return 0
  const hit = count(usage.cacheReadTokens)
  const miss = count(usage.inputTokens) + count(usage.cacheWriteTokens)
  const out = count(usage.outputTokens) + count(usage.reasoningTokens)
  return (hit / 1e6) * count(price.hit) + (miss / 1e6) * count(price.miss) + (out / 1e6) * count(price.out)
}

function priceOf(prices, model, time) {
  const table = prices[model] ?? prices['deepseek-flash']
  if (!table) return null
  return isPeak(time) ? table.peak : table.idle
}

function isPeak(time) {
  const local = new Date(time + 8 * 3600 * 1000)
  const day = local.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = local.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function recordBalanceSnapshot(controller, totals, now) {
  const account = controller.account?.value
  if (!account?.signedIn || typeof account.balance !== 'number' || !Number.isFinite(account.balance)) return null
  try {
    const file = stateFile()
    const day = localDayKey(now)
    let state
    try {
      state = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
    if (!state || state.day !== day || !Number.isFinite(state.first)) {
      state = { day, first: account.balance, at: now }
      writeJsonAtomic(file, state)
      return { first: state.first, at: state.at, spent: 0 }
    }
    return { first: state.first, at: state.at, spent: round(Math.max(0, state.first - account.balance)) }
  } catch (error) {
    controller.log('warn', `balance snapshot skipped: ${describe(error)}`)
    return null
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value))
    renameSync(temporary, file)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
}

function stateFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-balance-panel', 'balance.json')
}

function localDayKey(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const ROUTES = new WeakMap()

function registerRoute(ctx, controller) {
  let webServer
  try {
    webServer = ctx.get?.('webServer')
  } catch {
    webServer = undefined
  }
  if (typeof webServer?.register !== 'function') {
    controller.log('warn', 'no web server in this profile: the window cannot read the host')
    return
  }

  const previous = ROUTES.get(webServer)
  if (previous !== undefined) {
    ROUTES.delete(webServer)
    try { previous.dispose() } catch {}
  }

  const handler = async (request, response) => {
    await handle(request, response, controller)
  }

  let dispose
  try {
    dispose = webServer.register({ kind: 'exact', path: API_PATH, handler })
  } catch (error) {
    controller.log('warn', `could not register ${API_PATH}: ${describe(error)}`)
    return
  }

  const record = {
    dispose: typeof dispose === 'function' ? dispose : () => {},
  }
  ROUTES.set(webServer, record)

  try {
    ctx.effect(() => () => {
      if (ROUTES.get(webServer) !== record) return
      ROUTES.delete(webServer)
      try { record.dispose() } catch {}
    }, 'balance-panel.api()')
  } catch {}

  controller.log('info', `registered ${API_PATH}`)
}

function service(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

function recordId(record) {
  const id = record?.header?.id ?? record?.id ?? record?.sessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function recordStamp(record) {
  for (const key of ['updatedAt', 'lastEventAt', 'modifiedAt', 'createdAt']) {
    if (Number.isFinite(record?.[key])) return record[key]
    if (Number.isFinite(record?.header?.[key])) return record.header[key]
  }
  return null
}

/** Log-file mtimes keyed by session id; the cheap activity signal the listing lacks. */
function sessionMtimes() {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const mtimes = new Map()
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return mtimes
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let sessions
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const filename of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        try {
          mtimes.set(session.name, statSync(join(workspacePath, session.name, filename)).mtimeMs)
          break
        } catch {}
      }
    }
  }
  return mtimes
}

function startOfDay(time) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function shiftDays(time, amount) {
  const date = new Date(time)
  date.setDate(date.getDate() + amount)
  return date.getTime()
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export {
  cost,
  isLocalRequest,
  isPeak,
  localDayKey,
  mergePrices,
  readTitleSafe,
  readUsage,
  registerRoute,
  sessionFold,
  startOfDay,
}
