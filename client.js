window.__ModuleLoader__.load({
  id: 'dsh-balance-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-balance-panel'
    const SLOT = 'sidebar.footer.action'
    const API_PATH = '/dsh-balance-panel/api/state'
    const POLL_MS = 45000
    const REQUEST_TIMEOUT_MS = 15000

    const DICTIONARIES = {
      zh: {
        panel: '用量概览',
        connected: '数据已同步',
        syncing: '正在同步',
        reconnect: '连接中断',
        balance: '可用余额',
        todaySpend: '今日估算',
        weekSpend: '近 7 天',
        calls: '次调用',
        dailyAverage: '日均',
        remaining: '剩余',
        sinceSnapshot: '今日记录消耗',
        used: '已用',
        details: '详情',
        collapse: '收起',
        refresh: '刷新',
        refreshData: '刷新用量数据',
        updated: '更新于',
        never: '等待首次同步',
        notSignedIn: '未登录',
        offline: '暂时无法连接宿主',
        stale: '当前显示上次成功数据',
        trend: '用量趋势',
        conversations: '对话明细',
        noData: '近 7 天还没有用量记录',
        noConversations: '今日还没有消耗记录',
        modelShare: '模型占比',
        costShare: '按估算消耗',
        cacheHit: '缓存命中',
        incomplete: '部分会话未能读取，统计可能不完整',
        topUp: '充值',
        expand: '展开用量详情',
        collapsePanel: '收起用量详情',
        localEstimate: '消耗根据本地日志估算，非平台账单',
        today: '今天',
        activeDays: '天有记录',
        unknownModel: '未知模型',
        moreModels: '个模型',
        railLabel: '余额面板，点击刷新',
      },
      en: {
        panel: 'Usage overview',
        connected: 'Synced',
        syncing: 'Syncing',
        reconnect: 'Disconnected',
        balance: 'Available balance',
        todaySpend: 'Estimated today',
        weekSpend: 'Last 7 days',
        calls: 'calls',
        dailyAverage: 'Daily avg.',
        remaining: 'remaining',
        sinceSnapshot: 'Recorded spend',
        used: 'Used',
        details: 'Details',
        collapse: 'Less',
        refresh: 'Refresh',
        refreshData: 'Refresh usage data',
        updated: 'Updated',
        never: 'Waiting for first sync',
        notSignedIn: 'Not signed in',
        offline: 'Host is temporarily unreachable',
        stale: 'Showing the last successful snapshot',
        trend: 'Usage trend',
        conversations: 'Conversations',
        noData: 'No usage recorded in the last 7 days',
        noConversations: 'No spend recorded today',
        modelShare: 'Model share',
        costShare: 'By estimated spend',
        cacheHit: 'Cache hit',
        incomplete: 'Some sessions could not be read; totals may be incomplete',
        topUp: 'Top up',
        expand: 'Expand usage details',
        collapsePanel: 'Collapse usage details',
        localEstimate: 'Spend is estimated from local logs, not a platform invoice',
        today: 'Today',
        activeDays: 'active days',
        unknownModel: 'Unknown model',
        moreModels: 'more models',
        railLabel: 'Balance panel, click to refresh',
      },
    }

    let hostTranslate
    const locale = () => (typeof navigator === 'object' && navigator.language) || 'zh-CN'
    const builtIn = () => /^zh/i.test(locale()) ? DICTIONARIES.zh : DICTIONARIES.en
    const t = (key) => {
      try {
        const value = hostTranslate?.(key)
        if (typeof value === 'string' && value.length > 0 && value !== key && value !== `${NS}:${key}` && value !== `${NS}.${key}`) return value
      } catch {}
      return builtIn()[key] ?? key
    }

    const money = (value, currency = 'CNY') => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
      const absolute = Math.abs(value)
      const digits = absolute > 0 && absolute < 0.01 ? 4 : 2
      const formatted = absolute.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
      return `${value < 0 ? '-' : ''}${symbol}${formatted}`
    }

    const tokenCount = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(value)
      }
    }

    const stamp = (ms, full = false) => {
      if (!Number.isFinite(ms)) return ''
      try {
        return new Intl.DateTimeFormat(locale(), full
          ? { dateStyle: 'medium', timeStyle: 'medium' }
          : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
      } catch {
        return new Date(ms).toLocaleString()
      }
    }

    const dayLabel = (ms) => {
      try {
        return new Intl.DateTimeFormat(locale(), { weekday: 'narrow' }).format(new Date(ms))
      } catch {
        return ''
      }
    }

    const clamp = (value) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
    const percent = (value) => `${clamp(value).toFixed(1)}%`
    const safeExternalUrl = (value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:' ? url.toString() : null
      } catch {
        return null
      }
    }

    const modelName = (model) => {
      if (!model || model === 'unknown') return t('unknownModel')
      if (model === 'deepseek-flash') return 'Flash'
      if (model === 'deepseek-v4-pro') return 'V4 Pro'
      return String(model).replace(/^deepseek-/, '')
    }

    const candidates = () => {
      const urls = []
      try {
        if (location?.origin) urls.push(new URL(API_PATH, location.origin).toString())
      } catch {}
      try {
        urls.push(new URL(API_PATH, document.baseURI).toString())
      } catch {}
      urls.push(API_PATH)
      return [...new Set(urls)]
    }

    let activeUrl
    const read = async () => {
      const list = candidates()
      const order = activeUrl === undefined ? list : [activeUrl, ...list.filter((url) => url !== activeUrl)]
      let failure
      for (const url of order) {
        const abort = typeof AbortController === 'function' ? new AbortController() : null
        const timer = abort ? setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS) : null
        try {
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            signal: abort?.signal,
          })
          const text = await response.text()
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = text.length === 0 ? null : JSON.parse(text)
          if (!body || typeof body !== 'object') throw new Error('Invalid host response')
          activeUrl = url
          return body
        } catch (error) {
          failure = error
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      }
      throw failure ?? new Error('unreachable')
    }

    const store = { data: null, error: null, at: 0, busy: false, listeners: new Set() }
    const publish = (patch) => {
      Object.assign(store, patch)
      for (const listener of [...store.listeners]) {
        try { listener() } catch {}
      }
    }

    const load = async () => {
      if (store.busy) return
      publish({ busy: true })
      try {
        publish({ data: await read(), error: null, at: Date.now() })
      } catch (error) {
        publish({ error: String(error?.message ?? error) })
      } finally {
        publish({ busy: false })
      }
    }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        store.listeners.add(force)
        void load()
        const timer = setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
        const onFocus = () => { void load() }
        const onVisibility = () => { if (!document.hidden) void load() }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          store.listeners.delete(force)
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])
      return store
    }

    const ICON_PATHS = {
      wallet: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h11A2.5 2.5 0 0 1 19 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 3 16.5v-9Zm1-2V5a2 2 0 0 1 2-2h9v2M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z',
      refresh: 'M20 6v5h-5M4 18v-5h5M6.1 8a7 7 0 0 1 11.7-2.1L20 8M4 16l2.2 2.1A7 7 0 0 0 17.9 16',
      chevron: 'm7 10 5 5 5-5',
      chart: 'M4 19V9m5 10V5m5 14v-7m5 7V3M2 21h20',
      message: 'M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2.2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z',
      arrow: 'M7 17 17 7M7 7h10v10',
      alert: 'M12 9v4m0 4h.01M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z',
    }

    const icon = (name, size = 16) => h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    }, h('path', { d: ICON_PATHS[name] ?? ICON_PATHS.chart }))

    const STYLES = `
      .dsh-bp {
        --bp-text: var(--dsw-alias-label-primary, #24292f);
        --bp-muted: rgba(110, 118, 129, .9);
        --bp-muted: color-mix(in srgb, var(--bp-text) 72%, transparent);
        --bp-faint: rgba(110, 118, 129, .82);
        --bp-faint: color-mix(in srgb, var(--bp-text) 62%, transparent);
        --bp-border: rgba(127, 127, 127, .18);
        --bp-border: color-mix(in srgb, var(--bp-text) 11%, transparent);
        --bp-surface: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .055));
        --bp-hover: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .1));
        --bp-track: rgba(127, 127, 127, .14);
        --bp-accent: var(--dsw-alias-brand-primary, #536dfe);
        --bp-warn: var(--dsw-alias-state-warn-primary, #d97706);
        --bp-danger: var(--dsw-alias-state-error-primary, #d1242f);
        --bp-success: var(--dsw-alias-state-success-primary, #1a7f37);
        width: 100%;
        box-sizing: border-box;
        padding: 5px 6px;
        color: var(--bp-text);
        font-family: inherit;
        font-size: 12px;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
      }
      .dsh-bp *, .dsh-bp *::before, .dsh-bp *::after { box-sizing: border-box; }
      .dsh-bp button, .dsh-bp a { -webkit-tap-highlight-color: transparent; }
      .dsh-bp button { font: inherit; }
      .dsh-bp button:focus-visible, .dsh-bp a:focus-visible {
        outline: 2px solid var(--bp-accent);
        outline-offset: 2px;
      }
      .dsh-bp-card {
        overflow: hidden;
        border: 1px solid var(--bp-border);
        border-radius: 14px;
        background:
          radial-gradient(circle at 0 0, color-mix(in srgb, var(--bp-accent) 9%, transparent), transparent 46%),
          var(--bp-surface);
        box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
      }
      .dsh-bp-head { display: flex; align-items: center; gap: 8px; padding: 11px 11px 0; }
      .dsh-bp-mark {
        display: grid; place-items: center; flex: 0 0 auto; width: 27px; height: 27px;
        border-radius: 8px; color: var(--bp-accent);
        background: color-mix(in srgb, var(--bp-accent) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--bp-accent) 13%, transparent);
      }
      .dsh-bp-heading { flex: 1; min-width: 0; }
      .dsh-bp-title { font-size: 11px; font-weight: 650; letter-spacing: .01em; }
      .dsh-bp-status { display: flex; align-items: center; gap: 4px; margin-top: 1px; color: var(--bp-muted); font-size: 10px; }
      .dsh-bp-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--bp-success); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bp-success) 10%, transparent); }
      .dsh-bp-dot.is-busy { background: var(--bp-accent); animation: dsh-bp-pulse 1.4s ease-in-out infinite; }
      .dsh-bp-dot.is-error { background: var(--bp-danger); }
      .dsh-bp-topup {
        display: inline-flex; align-items: center; gap: 2px; padding: 4px 6px; border-radius: 6px;
        color: var(--bp-muted); font-size: 10px; text-decoration: none;
      }
      .dsh-bp-topup:hover { color: var(--bp-accent); background: var(--bp-hover); }
      .dsh-bp-balance { padding: 9px 12px 0; }
      .dsh-bp-label { color: var(--bp-muted); font-size: 11px; }
      .dsh-bp-balance-value { margin-top: 1px; font-size: 27px; line-height: 34px; font-weight: 710; letter-spacing: -.035em; }
      .dsh-bp-balance-value.is-empty { font-size: 18px; letter-spacing: -.01em; }
      .dsh-bp-meter-wrap { padding: 7px 12px 0; }
      .dsh-bp-meter { display: flex; width: 100%; height: 5px; overflow: hidden; border-radius: 999px; background: var(--bp-track); }
      .dsh-bp-meter-used { height: 100%; background: color-mix(in srgb, var(--bp-warn) 72%, transparent); }
      .dsh-bp-meter-left { height: 100%; background: var(--bp-accent); transition: width .35s ease; }
      .dsh-bp-meter-caption { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; color: var(--bp-muted); font-size: 10px; }
      .dsh-bp-metrics { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; padding: 10px 11px 0; }
      .dsh-bp-metric { min-width: 0; padding: 8px 9px; border: 1px solid var(--bp-border); border-radius: 9px; background: color-mix(in srgb, var(--bp-text) 2.5%, transparent); }
      .dsh-bp-metric-label { overflow: hidden; color: var(--bp-muted); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-metric-value { margin-top: 2px; overflow: hidden; font-size: 14px; line-height: 19px; font-weight: 650; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-metric-sub { margin-top: 1px; overflow: hidden; color: var(--bp-faint); font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-banner { display: flex; align-items: flex-start; gap: 5px; margin: 8px 11px 0; padding: 6px 7px; border-radius: 7px; color: var(--bp-warn); background: color-mix(in srgb, var(--bp-warn) 8%, transparent); font-size: 10px; }
      .dsh-bp-banner svg { flex: 0 0 auto; margin-top: 1px; }
      .dsh-bp-details { margin: 10px 11px 0; padding-top: 9px; border-top: 1px solid var(--bp-border); }
      .dsh-bp-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; padding: 3px; border-radius: 8px; background: var(--bp-track); }
      .dsh-bp-tab { min-height: 25px; border: 0; border-radius: 6px; color: var(--bp-muted); background: transparent; cursor: pointer; font-size: 11px; }
      .dsh-bp-tab:hover { color: var(--bp-text); }
      .dsh-bp-tab.is-active { color: var(--bp-text); background: var(--bp-surface); box-shadow: 0 1px 3px rgba(0, 0, 0, .08); font-weight: 600; }
      .dsh-bp-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 11px 1px 7px; }
      .dsh-bp-section-title { font-size: 11px; font-weight: 600; }
      .dsh-bp-section-note { color: var(--bp-faint); font-size: 9.5px; }
      .dsh-bp-chart { display: flex; align-items: flex-end; gap: 5px; height: 63px; padding: 3px 2px 0; }
      .dsh-bp-day { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; height: 100%; }
      .dsh-bp-bar-track { display: flex; align-items: flex-end; justify-content: center; width: 100%; height: 43px; }
      .dsh-bp-bar { display: block; width: min(100%, 18px); min-height: 2px; border-radius: 4px 4px 2px 2px; background: color-mix(in srgb, var(--bp-accent) 38%, transparent); transition: height .3s ease; }
      .dsh-bp-bar.is-today { background: var(--bp-accent); }
      .dsh-bp-bar.is-zero { background: var(--bp-track); }
      .dsh-bp-day-label { color: var(--bp-faint); font-size: 10px; }
      .dsh-bp-day.is-today .dsh-bp-day-label { color: var(--bp-accent); font-weight: 650; }
      .dsh-bp-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
      .dsh-bp-chip { padding: 3px 6px; border-radius: 999px; color: var(--bp-muted); background: var(--bp-track); font-size: 9.5px; }
      .dsh-bp-model-bar { display: flex; height: 5px; overflow: hidden; border-radius: 999px; background: var(--bp-track); }
      .dsh-bp-model-bar span { height: 100%; }
      .dsh-bp-tone-0 { background: var(--bp-accent); }
      .dsh-bp-tone-1 { background: #8b5cf6; }
      .dsh-bp-tone-2 { background: #0ea5a4; }
      .dsh-bp-tone-3 { background: var(--bp-warn); }
      .dsh-bp-tone-rest { background: color-mix(in srgb, var(--bp-text) 24%, transparent); }
      .dsh-bp-model-list { display: grid; gap: 6px; margin-top: 8px; }
      .dsh-bp-model-row { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 10px; }
      .dsh-bp-model-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 2px; }
      .dsh-bp-model-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-model-meta { color: var(--bp-faint); font-size: 9.5px; }
      .dsh-bp-model-cost { font-weight: 600; }
      .dsh-bp-empty { display: grid; place-items: center; gap: 5px; min-height: 76px; padding: 12px; color: var(--bp-faint); text-align: center; font-size: 9.5px; }
      .dsh-bp-conversations { display: grid; gap: 2px; max-height: 224px; margin: 8px -3px 0; overflow-y: auto; scrollbar-width: thin; }
      .dsh-bp-conversation { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 7px 4px; border-radius: 7px; }
      .dsh-bp-conversation:hover { background: var(--bp-hover); }
      .dsh-bp-conversation-icon { display: grid; place-items: center; flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px; color: var(--bp-muted); background: var(--bp-track); }
      .dsh-bp-conversation-main { flex: 1; min-width: 0; }
      .dsh-bp-conversation-title { overflow: hidden; font-size: 11px; font-weight: 550; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-conversation-sub { margin-top: 2px; overflow: hidden; color: var(--bp-faint); font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-conversation-cost { flex: 0 0 auto; font-size: 11px; font-weight: 650; }
      .dsh-bp-estimate { margin-top: 9px; color: var(--bp-faint); font-size: 9.5px; text-align: center; }
      .dsh-bp-footer { display: flex; align-items: center; justify-content: space-between; gap: 5px; padding: 9px 9px 8px 11px; }
      .dsh-bp-updated { flex: 1; min-width: 0; overflow: hidden; color: var(--bp-faint); font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
      .dsh-bp-actions { display: flex; align-items: center; gap: 2px; }
      .dsh-bp-icon-button, .dsh-bp-expand {
        display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 25px;
        border: 0; border-radius: 6px; color: var(--bp-muted); background: transparent; cursor: pointer;
      }
      .dsh-bp-icon-button:hover, .dsh-bp-expand:hover { color: var(--bp-text); background: var(--bp-hover); }
      .dsh-bp-icon-button:disabled { cursor: wait; opacity: .55; }
      .dsh-bp-icon-button.is-busy svg { animation: dsh-bp-spin .9s linear infinite; }
      .dsh-bp-expand { gap: 2px; padding: 0 4px 0 7px; font-size: 10px; }
      .dsh-bp-expand svg { transition: transform .18s ease; }
      .dsh-bp-expand.is-open svg { transform: rotate(180deg); }
      .dsh-bp-rail-root { display: flex; justify-content: center; padding: 5px 0; }
      .dsh-bp-rail {
        position: relative; display: grid; place-items: center; width: 34px; height: 34px; padding: 0;
        border: 1px solid var(--bp-border); border-radius: 10px; color: var(--bp-accent);
        background: var(--bp-surface); cursor: pointer; font-size: 14px; font-weight: 700;
      }
      .dsh-bp-rail:hover { background: var(--bp-hover); }
      .dsh-bp-rail .dsh-bp-dot { position: absolute; right: 3px; bottom: 3px; width: 4px; height: 4px; }
      @keyframes dsh-bp-spin { to { transform: rotate(360deg); } }
      @keyframes dsh-bp-pulse { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) {
        .dsh-bp *, .dsh-bp *::before, .dsh-bp *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
      }
    `

    const metric = (label, value, sub) => h('div', { className: 'dsh-bp-metric' },
      h('div', { className: 'dsh-bp-metric-label' }, label),
      h('div', { className: 'dsh-bp-metric-value' }, value),
      h('div', { className: 'dsh-bp-metric-sub' }, sub))

    const emptyState = (message) => h('div', { className: 'dsh-bp-empty' }, icon('chart', 20), h('span', null, message))

    const renderTrend = (history, currency) => {
      const days = Array.isArray(history?.days) ? history.days.slice(-7) : []
      if (days.length === 0) return emptyState(t('noData'))
      const maximum = Math.max(0, ...days.map((day) => Number.isFinite(day?.cost) ? day.cost : 0))
      const activeDays = days.filter((day) => day?.calls > 0).length
      const total = history?.total ?? {}
      const cacheBase = (total.cacheRead ?? 0) + (total.input ?? 0)
      const cacheRate = cacheBase > 0 ? ((total.cacheRead ?? 0) / cacheBase) * 100 : 0

      return h(React.Fragment, null,
        h('div', { className: 'dsh-bp-section-head' },
          h('span', { className: 'dsh-bp-section-title' }, t('trend')),
          h('span', { className: 'dsh-bp-section-note' }, `${t('dailyAverage')} ${money(history?.averageCost, currency)}`)),
        h('div', { className: 'dsh-bp-chart', role: 'img', 'aria-label': `${t('weekSpend')} ${money(total.cost, currency)}` },
          days.map((day, index) => {
            const amount = Number.isFinite(day?.cost) ? day.cost : 0
            const height = amount > 0 && maximum > 0 ? Math.max(5, (amount / maximum) * 41) : 2
            const current = index === days.length - 1
            return h('div', {
              key: day.day ?? day.start ?? index,
              className: `dsh-bp-day${current ? ' is-today' : ''}`,
              title: `${stamp(day.start, true)} · ${money(amount, currency)} · ${day.calls ?? 0} ${t('calls')}`,
            },
            h('div', { className: 'dsh-bp-bar-track' },
              h('span', {
                className: `dsh-bp-bar${current ? ' is-today' : ''}${amount === 0 ? ' is-zero' : ''}`,
                style: { height: `${height}px` },
              })),
            h('span', { className: 'dsh-bp-day-label' }, dayLabel(day.start)))
          })),
        h('div', { className: 'dsh-bp-chips' },
          h('span', { className: 'dsh-bp-chip' }, `${activeDays}/7 ${t('activeDays')}`),
          h('span', { className: 'dsh-bp-chip' }, `${t('cacheHit')} ${percent(cacheRate)}`),
          h('span', { className: 'dsh-bp-chip' }, `${tokenCount(total.tokens?.total)} Tokens`)))
    }

    const renderModels = (models, currency) => {
      if (!Array.isArray(models) || models.length === 0) return null
      const total = models.reduce((sum, item) => sum + (Number.isFinite(item?.cost) ? item.cost : 0), 0)
      if (total <= 0) return null
      const visible = models.slice(0, 4)
      const rest = models.slice(4)
      const restCost = rest.reduce((sum, item) => sum + (Number.isFinite(item?.cost) ? item.cost : 0), 0)
      const restCalls = rest.reduce((sum, item) => sum + (Number.isFinite(item?.calls) ? item.calls : 0), 0)
      const restPercent = (restCost / total) * 100

      const segments = visible.map((item, index) => {
        const share = clamp(((Number.isFinite(item?.cost) ? item.cost : 0) / total) * 100)
        return h('span', {
          key: item?.model ?? index,
          className: `dsh-bp-tone-${index % 4}`,
          style: { width: `${share}%` },
          title: `${modelName(item?.model)} · ${percent(share)}`,
        })
      })
      if (rest.length > 0) segments.push(h('span', {
        key: 'rest',
        className: 'dsh-bp-tone-rest',
        style: { width: `${clamp(restPercent)}%` },
        title: `+${rest.length} ${t('moreModels')} · ${money(restCost, currency)}`,
      }))

      const rows = visible.map((item, index) => {
        const share = clamp(((Number.isFinite(item?.cost) ? item.cost : 0) / total) * 100)
        return h('div', { className: 'dsh-bp-model-row', key: item?.model ?? index },
          h('span', { className: `dsh-bp-model-dot dsh-bp-tone-${index % 4}` }),
          h('span', { className: 'dsh-bp-model-name', title: item?.model }, modelName(item?.model)),
          h('span', { className: 'dsh-bp-model-meta' }, `${item?.calls ?? 0} ${t('calls')} · ${percent(share)}`),
          h('span', { className: 'dsh-bp-model-cost' }, money(item?.cost, currency)))
      })
      if (rest.length > 0) rows.push(h('div', { className: 'dsh-bp-model-row', key: 'rest' },
        h('span', { className: 'dsh-bp-model-dot dsh-bp-tone-rest' }),
        h('span', { className: 'dsh-bp-model-name' }, `+${rest.length} ${t('moreModels')}`),
        h('span', { className: 'dsh-bp-model-meta' }, `${restCalls} ${t('calls')} · ${percent(restPercent)}`),
        h('span', { className: 'dsh-bp-model-cost' }, money(restCost, currency))))

      return h(React.Fragment, null,
        h('div', { className: 'dsh-bp-section-head' },
          h('span', { className: 'dsh-bp-section-title' }, t('modelShare')),
          h('span', { className: 'dsh-bp-section-note' }, t('costShare'))),
        h('div', { className: 'dsh-bp-model-bar', role: 'img', 'aria-label': t('modelShare') }, segments),
        h('div', { className: 'dsh-bp-model-list' }, rows))
    }

    const renderConversations = (conversations, currency) => {
      if (!Array.isArray(conversations) || conversations.length === 0) return emptyState(t('noConversations'))
      return h('div', { className: 'dsh-bp-conversations' }, conversations.slice(0, 20).map((item, index) => {
        const title = item?.title || String(item?.id ?? `#${index + 1}`).slice(0, 18)
        return h('div', { className: 'dsh-bp-conversation', key: item?.id ?? index, title: `${title} · ${stamp(item?.lastAt, true)}` },
          h('span', { className: 'dsh-bp-conversation-icon' }, icon('message', 13)),
          h('div', { className: 'dsh-bp-conversation-main' },
            h('div', { className: 'dsh-bp-conversation-title' }, title),
            h('div', { className: 'dsh-bp-conversation-sub' }, `${modelName(item?.model)} · ${item?.calls ?? 0} ${t('calls')} · ${tokenCount(item?.tokens?.total)} Tokens`)),
          h('span', { className: 'dsh-bp-conversation-cost' }, `≈${money(item?.cost, currency)}`))
      }))
    }

    function BalanceBlock(props) {
      const wide = props?.wide !== false
      const { data, error, at, busy } = useStore()
      const [open, setOpen] = React.useState(false)
      const [tab, setTab] = React.useState('trend')

      const account = data?.account ?? null
      const today = data?.today ?? null
      const history = data?.history ?? null
      const currency = account?.currency ?? 'CNY'
      const signedIn = account?.signedIn === true
      const balance = typeof account?.balance === 'number' && Number.isFinite(account.balance) ? account.balance : null
      const spend = typeof today?.cost === 'number' && Number.isFinite(today.cost) ? today.cost : null
      const snapshotFirst = typeof today?.delta?.first === 'number' && today.delta.first > 0 ? today.delta.first : null
      const exactSpend = snapshotFirst !== null && typeof today?.delta?.spent === 'number' && Number.isFinite(today.delta.spent) ? today.delta.spent : null
      const baseline = snapshotFirst ?? (balance !== null && spend !== null && balance + spend > 0 ? balance + spend : null)
      const leftPercent = baseline !== null && balance !== null ? clamp((balance / baseline) * 100) : 0
      const usedPercent = baseline !== null ? 100 - leftPercent : 0
      const conversations = Array.isArray(data?.conversations) ? data.conversations : []
      const topUpUrl = safeExternalUrl(account?.links?.topUpUrl)
      const status = error ? t('reconnect') : busy ? t('syncing') : signedIn ? t('connected') : data ? t('notSignedIn') : t('syncing')
      const balanceText = data ? signedIn ? money(balance, currency) : t('notSignedIn') : '—'

      if (!wide) {
        const title = error
          ? `${t('offline')}: ${error}`
          : signedIn ? `${t('balance')} ${money(balance, currency)} · ${t('todaySpend')} ${money(spend, currency)}` : t('notSignedIn')
        return h('div', { className: 'dsh-bp dsh-bp-rail-root', 'data-plugin': NS },
          h('style', null, STYLES),
          h('button', {
            type: 'button',
            className: 'dsh-bp-rail',
            title,
            'aria-label': `${t('railLabel')}. ${title}`,
            onClick: () => { void load() },
          }, signedIn ? '¥' : '—', h('span', { className: `dsh-bp-dot${busy ? ' is-busy' : ''}${error ? ' is-error' : ''}` })))
      }

      return h('div', { className: 'dsh-bp', 'data-plugin': NS },
        h('style', null, STYLES),
        h('section', { className: 'dsh-bp-card', 'aria-label': t('panel'), 'aria-busy': busy ? 'true' : 'false' },
          h('div', { className: 'dsh-bp-head' },
            h('span', { className: 'dsh-bp-mark' }, icon('wallet', 16)),
            h('div', { className: 'dsh-bp-heading' },
              h('div', { className: 'dsh-bp-title' }, t('panel')),
              h('div', { className: 'dsh-bp-status', role: 'status' },
                h('span', { className: `dsh-bp-dot${busy ? ' is-busy' : ''}${error ? ' is-error' : ''}` }), status)),
            topUpUrl && signedIn ? h('a', {
              className: 'dsh-bp-topup',
              href: topUpUrl,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t('topUp'), icon('arrow', 10)) : null),
          h('div', { className: 'dsh-bp-balance' },
            h('div', { className: 'dsh-bp-label' }, t('balance')),
            h('div', { className: `dsh-bp-balance-value${!signedIn ? ' is-empty' : ''}` }, balanceText)),
          baseline !== null && balance !== null ? h('div', { className: 'dsh-bp-meter-wrap' },
            h('div', {
              className: 'dsh-bp-meter',
              role: 'progressbar',
              'aria-label': `${money(balance, currency)} ${t('remaining')}`,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(leftPercent),
            },
            h('span', { className: 'dsh-bp-meter-used', style: { width: `${usedPercent}%` } }),
            h('span', { className: 'dsh-bp-meter-left', style: { width: `${leftPercent}%` } })),
            h('div', { className: 'dsh-bp-meter-caption' },
              h('span', null, `${exactSpend !== null ? t('sinceSnapshot') : t('todaySpend')} ${money(exactSpend ?? spend, currency)}`),
              h('span', null, `${percent(leftPercent)} ${t('remaining')}`))) : null,
          h('div', { className: 'dsh-bp-metrics' },
            metric(t('todaySpend'), money(spend, currency), `${data ? (today?.calls ?? 0) : '—'} ${t('calls')} · ${tokenCount(today?.tokens?.total)}`),
            metric(t('weekSpend'), money(history?.total?.cost, currency), `${t('dailyAverage')} ${money(history?.averageCost, currency)}`)),
          error ? h('div', { className: 'dsh-bp-banner', title: error }, icon('alert', 12),
            h('span', null, `${t('offline')}${data ? ` · ${t('stale')}` : ''}`)) : null,
          open ? h('div', { className: 'dsh-bp-details', id: 'dsh-balance-details' },
            h('div', { className: 'dsh-bp-tabs', role: 'group', 'aria-label': t('details') },
              h('button', {
                type: 'button',
                className: `dsh-bp-tab${tab === 'trend' ? ' is-active' : ''}`,
                'aria-pressed': tab === 'trend' ? 'true' : 'false',
                onClick: () => setTab('trend'),
              }, t('trend')),
              h('button', {
                type: 'button',
                className: `dsh-bp-tab${tab === 'conversations' ? ' is-active' : ''}`,
                'aria-pressed': tab === 'conversations' ? 'true' : 'false',
                onClick: () => setTab('conversations'),
              }, t('conversations'))),
            today?.complete === false || history?.complete === false ? h('div', { className: 'dsh-bp-banner' }, icon('alert', 12), h('span', null, t('incomplete'))) : null,
            tab === 'trend'
              ? h(React.Fragment, null,
                renderTrend(history, currency),
                renderModels(Array.isArray(history?.models) && history.models.length > 0 ? history.models : today?.models, currency))
              : renderConversations(conversations, currency),
            h('div', { className: 'dsh-bp-estimate' }, t('localEstimate'))) : null,
          h('div', { className: 'dsh-bp-footer' },
            h('span', { className: 'dsh-bp-updated', title: at ? stamp(at, true) : '' }, at ? `${t('updated')} ${stamp(at)}` : t('never')),
            h('div', { className: 'dsh-bp-actions' },
              h('button', {
                type: 'button',
                className: `dsh-bp-icon-button${busy ? ' is-busy' : ''}`,
                title: t('refreshData'),
                'aria-label': t('refreshData'),
                disabled: busy,
                onClick: () => { void load() },
              }, icon('refresh', 13)),
              h('button', {
                type: 'button',
                className: `dsh-bp-expand${open ? ' is-open' : ''}`,
                title: open ? t('collapsePanel') : t('expand'),
                'aria-label': open ? t('collapsePanel') : t('expand'),
                'aria-expanded': open ? 'true' : 'false',
                'aria-controls': 'dsh-balance-details',
                onClick: () => setOpen((value) => !value),
              }, open ? t('collapse') : t('details'), icon('chevron', 12))))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-balance-panel:locale')
          const bound = ctx.locale.bind(NS)
          hostTranslate = (key) => bound(key)
        } catch {}
        ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: 'balance', order: 5 }, BalanceBlock))
      },
    }
  },
})
