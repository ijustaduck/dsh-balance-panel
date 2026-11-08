import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
} from './index.js'

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('cost includes cache writes and reasoning tokens', () => {
  const usage = {
    inputTokens: 1000000,
    cacheWriteTokens: 500000,
    cacheReadTokens: 1000000,
    outputTokens: 250000,
    reasoningTokens: 250000,
  }
  closeTo(cost(usage, { hit: 0.02, miss: 1, out: 4 }), 3.52)
  assert.equal(cost({}, null), 0)
  assert.equal(cost({ inputTokens: -100, outputTokens: Number.NaN }, { hit: 1, miss: 1, out: 1 }), 0)
})

test('peak boundaries follow Beijing business hours', () => {
  const at = (value) => new Date(value).getTime()
  assert.equal(isPeak(at('2026-11-09T08:59:59+08:00')), false)
  assert.equal(isPeak(at('2026-11-09T09:00:00+08:00')), true)
  assert.equal(isPeak(at('2026-11-09T11:59:59+08:00')), true)
  assert.equal(isPeak(at('2026-11-09T12:00:00+08:00')), false)
  assert.equal(isPeak(at('2026-11-09T14:00:00+08:00')), true)
  assert.equal(isPeak(at('2026-11-09T17:59:59+08:00')), true)
  assert.equal(isPeak(at('2026-11-09T18:00:00+08:00')), false)
  assert.equal(isPeak(at('2026-11-08T09:00:00+08:00')), false)
})

test('local day keys and day starts use the host timezone', () => {
  const time = new Date(2026, 10, 8, 0, 30, 0).getTime()
  assert.equal(localDayKey(time), '2026-11-08')
  const start = new Date(startOfDay(time))
  assert.deepEqual([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()], [0, 0, 0, 0])
})

test('readTitleSafe accepts current and legacy response shapes', async () => {
  assert.equal(await readTitleSafe({ readTitle: async () => 'current' }, 'a'), 'current')
  assert.equal(await readTitleSafe({ readTitle: async () => ({ title: 'legacy' }) }, 'a'), 'legacy')
  assert.equal(await readTitleSafe({ readTitle: async () => { throw new Error('missing') } }, 'a'), null)
})

test('price overrides reject invalid or incomplete values', () => {
  const prices = mergePrices({
    'deepseek-flash': { idle: { hit: 0.5, miss: Number.NaN, out: -1 } },
    'valid-model': {
      idle: { hit: 1, miss: 2, out: 3 },
      peak: { hit: 2, miss: 4, out: 6 },
    },
    'partial-model': { idle: { hit: 1, miss: 2, out: 3 } },
  })
  assert.equal(prices['deepseek-flash'].idle.hit, 0.5)
  assert.equal(prices['deepseek-flash'].idle.miss, 1)
  assert.equal(prices['deepseek-flash'].idle.out, 4)
  assert.deepEqual(prices['valid-model'].peak, { hit: 2, miss: 4, out: 6 })
  assert.equal(prices['partial-model'], undefined)
})

test('route reload disposes the old handler and cleanup preserves the new one', () => {
  const registrations = []
  let disposed = 0
  const webServer = {
    register(record) {
      const entry = { ...record, active: true }
      registrations.push(entry)
      return () => {
        if (entry.active) disposed += 1
        entry.active = false
      }
    },
  }
  const cleanups = []
  const ctx = {
    get: (name) => name === 'webServer' ? webServer : undefined,
    effect: (setup) => cleanups.push(setup()),
  }
  const controller = { log() {} }

  registerRoute(ctx, controller)
  registerRoute(ctx, controller)
  assert.equal(registrations.length, 2)
  assert.equal(disposed, 1)
  assert.equal(registrations[0].active, false)
  assert.equal(registrations[1].active, true)

  cleanups[0]()
  assert.equal(registrations[1].active, true)
  cleanups[1]()
  assert.equal(registrations[1].active, false)
  assert.equal(disposed, 2)
})

test('HTTP access is restricted to loopback peers and origins', () => {
  const request = (address, host, origin) => ({
    socket: { remoteAddress: address },
    headers: { host, ...(origin === undefined ? {} : { origin }) },
  })
  assert.equal(isLocalRequest(request('127.0.0.1', '127.0.0.1:7744')), true)
  assert.equal(isLocalRequest(request('::ffff:127.0.0.1', 'localhost:7744', 'http://localhost:7744')), true)
  assert.equal(isLocalRequest(request('192.168.1.2', '127.0.0.1:7744')), false)
  assert.equal(isLocalRequest(request('127.0.0.1', 'attacker.example')), false)
  assert.equal(isLocalRequest(request('127.0.0.1', '127.0.0.1.evil.com:7744')), false)
  assert.equal(isLocalRequest(request('127.0.0.1', '127.attacker.com:7744', 'http://127.attacker.com:7744')), false)
  assert.equal(isLocalRequest(request('::1', '[::1]:7744')), true)
  assert.equal(isLocalRequest(request('127.0.0.1', '127.0.0.1:7744', 'https://attacker.example')), false)
  assert.equal(isLocalRequest(request('127.0.0.1', '127.0.0.1:7744', 'null')), false)
})

test('sessionFold aggregates models and all billed token fields', async () => {
  const now = new Date(2026, 10, 8, 12).getTime()
  const time = startOfDay(now) + 3600000
  const event = (model, outputTokens, reasoningTokens) => ({
    type: 'assistant/message',
    time,
    data: {
      message: { source: { model } },
      usage: { inputTokens: 100, outputTokens, reasoningTokens, cacheReadTokens: 200, cacheWriteTokens: 10 },
    },
  })
  const controller = { prices: mergePrices(), sessions: new Map(), log() {} }
  const query = {
    readSession: async () => ({ events: [event('deepseek-flash', 20, 5), event('deepseek-v4-pro', 30, 10)] }),
    readTitle: async () => 'title',
  }
  const fold = await sessionFold(controller, query, undefined, 'session-a', false, now)
  const bucket = fold.days.get(startOfDay(now))
  assert.equal(fold.title, 'title')
  assert.equal(fold.error, null)
  assert.equal(bucket.calls, 2)
  assert.equal(bucket.output, 65)
  assert.equal(bucket.reasoning, 15)
  assert.equal(bucket.cacheWrite, 20)
  assert.deepEqual(Object.keys(bucket.models).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('history includes a session created before the window when its log changed inside it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bp-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sessionDir = join(home, 'sessions', '--E-test--', 'session-old')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), 'placeholder')

    const now = new Date(2026, 10, 8, 12, 0, 0).getTime()
    const oldCreatedAt = now - 10 * 86400000
    const event = {
      type: 'assistant/message',
      time: now,
      data: {
        message: { source: { model: 'deepseek-flash' } },
        usage: { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    }
    const query = {
      listSessions: async () => [{
        header: { id: 'session-old', cwd: '<workspace>', createdAt: oldCreatedAt },
        live: false,
        persisted: true,
      }],
      readSession: async () => ({ events: [event] }),
      readTitle: async () => 'old session',
    }
    const sessions = { list: () => [], get: () => undefined }
    const controller = {
      ctx: { get: (name) => name === 'sessionQuery' ? query : name === 'sessions' ? sessions : undefined },
      prices: mergePrices(),
      sessions: new Map(),
      log() {},
    }

    const result = await readUsage(controller, now)
    assert.equal(result.today.sessions, 1)
    assert.equal(result.history.total.calls, 1)
    assert.equal(result.history.complete, true)
    const today = result.history.days.find((day) => day.start === startOfDay(now))
    assert.equal(today.calls, 1)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
