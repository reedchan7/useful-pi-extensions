/**
 * Status line extension — replaces pi's footer with a labelled two-row one.
 *
 * See README.md for the rendered layout and what each part means.
 *
 * Design notes:
 *
 * - Every value carries a word ("Context", "Input", "Output", "Cache hit", "Cost", "Effort"), not a
 *   symbol: icon-only labels are unreadable at a glance.
 * - Keys render dim and values render brighter, so a key/value pair reads as one unit instead of as a
 *   run of equal-weight tokens.
 * - The meter is a FIXED 20 cells and never stretches to the terminal, so it reads as an instrument
 *   instead of as chrome. render.ts records where the idiom is from.
 * - Other extensions' ctx.ui.setStatus() entries are still rendered, or they would silently disappear
 *   from the footer.
 *
 * Throughput follows the deepseek-harness turn-metrics contract: ttftMs = firstTokenTime -
 * stepStartTime; decodeMs = completedTime - firstTokenTime; tok/s = usage.output / (decodeMs / 1000)
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import {
  avgTokPerSec,
  breakdownPanel,
  contextRow,
  currencyFromConfig,
  detailFromConfig,
  formatCwd,
  formatLatency,
  formatTps,
  avgMs,
  isQuietStatus,
  messagesTokens,
  pair,
  cachedRates,
  ratesFromPayload,
  cacheIsFresh,
  withCachedRates,
  withDetailFlag,
  promptBreakdown,
  row,
  shortenPath,
  splitToolTokens,
  ttftDisplay,
  ttftMs,
  USD,
  type Currency,
  type PromptBreakdown,
  type ToolSplit,
} from './render.ts'

const LIVE_RENDER_MS = 200
const WINDOW_MS = 2000
const MIN_SAMPLE_MS = 200
/** How often the waiting TTFT slot ticks while a request is in flight. */
const TICK_MS = 250
/** Pi's own estimateTokens() heuristic, used only until a real ratio is known. */
const FALLBACK_TOKENS_PER_CHAR = 0.25

/** The status line's own settings file, alongside pi's other per-tool config. */
/** Everything this extension keeps lives in one folder, not loose files relying on name prefixes. */
const STATUSLINE_DIR = join(homedir(), '.pi', 'agent', 'statusline')
const CONFIG_PATH = join(STATUSLINE_DIR, 'config.json')
/** Pre-1.8 locations, migrated out of on first start. */
const LEGACY_CONFIG = join(homedir(), '.pi', 'agent', 'statusline.json')
/** Free, keyless, and one request returns every currency — so the cache serves instant switching. */
const RATES_URL = 'https://open.er-api.com/v6/latest/USD'
/** Every session on this machine, for the day-cost total that spans projects and models. */
const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions')
/** Where throughput metrics wait out a /reload: keyed by session file, so a reload restores. */
/** One state file per session, so two concurrent sessions cannot clobber each other. */
const STATE_DIR = join(STATUSLINE_DIR, 'state')
const LEGACY_STATE = join(homedir(), '.pi', 'agent', 'statusline-state.json')
/** The 1.8 single-file state: one bucket every session shared, also migrated to per-session. */
const LEGACY_SHARED_STATE = join(STATUSLINE_DIR, 'state.json')
/** Pi's own default when settings name no reserve (DEFAULT_COMPACTION_SETTINGS). */
const DEFAULT_RESERVE_TOKENS = 16_384
/**
 * The key that toggles the breakdown line; change here if another extension owns it.
 *
 * Ctrl+j was tried first and had to go: legacy terminals send it as a bare LF, which is
 * indistinguishable from Enter, so it typed newlines instead of toggling. ctrl+e is unbound across
 * pi's default keymaps and in every extension installed on this machine.
 */
const BREAKDOWN_SHORTCUT = 'ctrl+e'
const FETCH_TIMEOUT_MS = 5000

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

async function fetchRates(): Promise<Record<string, number> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(RATES_URL, { signal: controller.signal })
    if (!response.ok) return null
    const rates = ratesFromPayload(await response.json())
    return Object.keys(rates).length === 0 ? null : rates
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads the display currency.
 *
 * `perUsd` is a pinned rate and wins untouched; a code without one resolves through the cached rate
 * table — today's table answers instantly, a stale one answers while a fresh one is fetched, and
 * only a first-ever failure speaks up. The whole table is cached because one request returns every
 * currency, which is also what makes switching codes instant and offline.
 *
 * Called once per session on purpose: a footer that stat'ed a file on every frame would be its own
 * bug. Editing the file therefore takes effect on `/reload`.
 */
function startOfToday(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerces a persisted counter back to a non-negative finite number, or 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Moves a pre-1.8 flat file into the extension folder; missing files are the normal case. */
async function migrateLegacyFile(legacy: string, current: string): Promise<void> {
  try {
    await mkdir(dirname(current), { recursive: true })
    await rename(legacy, current)
  } catch {
    // Nothing at the old path, or already migrated: either way the current file rules.
  }
}

/** Per-session state path: the session file's name is unique and stable across reloads. */
function statePath(sessionFile: string): string {
  return join(STATE_DIR, `${basename(sessionFile)}.json`)
}

/** Moves a shared-bucket state file to its per-session name; garbage in, ignored out. */
async function migrateLegacyState(legacy: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(legacy, 'utf8'))
    if (!isRecord(parsed) || typeof parsed.sessionFile !== 'string') return
    await mkdir(STATE_DIR, { recursive: true })
    await rename(legacy, statePath(parsed.sessionFile))
  } catch {
    // Nothing to migrate, or the file was not ours: leave it alone.
  }
}

/** Drops per-session state untouched for a week; older files restore nothing useful. */
async function pruneState(): Promise<void> {
  try {
    const files = await readdir(STATE_DIR)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    await Promise.all(
      files.map(async (name) => {
        const filePath = join(STATE_DIR, name)
        const stats = await stat(filePath).catch(() => null)
        if (stats !== null && stats.mtimeMs < cutoff) await unlink(filePath).catch(() => {})
        return null
      }),
    )
  } catch {
    // No state dir yet: nothing to prune.
  }
}

/** Today's provider cost of one session-file line, or null when the line bills nothing today. */
function entryCost(line: string, since: number): number | null {
  if (!line.includes('"usage"')) return null
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(entry) || typeof entry.timestamp !== 'string') return null
  if (Date.parse(entry.timestamp) < since) return null
  if (!isRecord(entry.usage) || !isRecord(entry.usage.cost)) return null
  const total = entry.usage.cost.total
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}

/**
 * Today's cost across every other session on this machine.
 *
 * Files not touched today are skipped unread, and this session's own file is skipped because its
 * cost is already live in totals.cost — counting both would double a resumed session.
 */
async function sumOtherTodaysCost(currentFile: string | null, since: number): Promise<number> {
  let dirs: string[] = []
  try {
    dirs = await readdir(SESSIONS_DIR)
  } catch {
    return 0
  }
  const lists = await Promise.all(
    dirs.map(async (dir) => {
      const dirPath = join(SESSIONS_DIR, dir)
      let names: string[] = []
      try {
        names = await readdir(dirPath)
      } catch {
        return []
      }
      return names
        .map((name) => join(dirPath, name))
        .filter((path) => path.endsWith('.jsonl') && path !== currentFile)
    }),
  )
  const costs = await Promise.all(
    lists.flat().map(async (path) => {
      try {
        if ((await stat(path)).mtimeMs < since) return 0
      } catch {
        return 0
      }
      const text = await readFile(path, 'utf8').catch(() => '')
      let total = 0
      for (const line of text.split('\n')) {
        const cost = entryCost(line, since)
        if (cost !== null) total += cost
      }
      return total
    }),
  )
  return costs.reduce((sum, value) => sum + value, 0)
}

async function loadCurrency(notify: (message: string) => void): Promise<Currency> {
  let text: string | null = null
  try {
    text = await readFile(CONFIG_PATH, 'utf8')
  } catch {
    // No config file is the normal case, and it means USD.
    return USD
  }
  const { currency, pending, problem } = currencyFromConfig(text)
  if (problem !== null) notify(problem)
  if (pending === null) return currency
  // Costs are already USD; a rates fetch could only ever return 1.
  if (pending.code === 'USD') return USD

  const cached = cachedRates(text)
  const known = cached?.rates[pending.code]
  if (cached !== null && known !== undefined && cacheIsFresh(cached.fetchedAt, today())) {
    return { symbol: pending.symbol, perUsd: known }
  }

  const fetched = await fetchRates()
  if (fetched !== null) {
    try {
      await writeFile(CONFIG_PATH, withCachedRates(text, fetched, today()))
    } catch {
      // The session still runs on the fetched rate; only tomorrow's warm start is lost.
    }
    return { symbol: pending.symbol, perUsd: fetched[pending.code] ?? USD.perUsd }
  }
  if (known !== undefined) return { symbol: pending.symbol, perUsd: known }
  notify(`could not fetch a ${pending.code} rate, showing USD`)
  return USD
}

/** A content block as providers stream it; every field is read defensively. */
type ContentBlock = {
  type?: unknown
  text?: unknown
  thinking?: unknown
  name?: unknown
  arguments?: unknown
}

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null
}

function blockChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0

  let chars = 0
  for (const raw of content as unknown[]) {
    if (!isContentBlock(raw)) continue
    const { type, text, thinking, name, arguments: args } = raw
    if (type === 'text' && typeof text === 'string') chars += text.length
    else if (type === 'thinking' && typeof thinking === 'string') chars += thinking.length
    else if (type === 'toolCall') {
      const nameLength = typeof name === 'string' ? name.length : 0
      chars += nameLength + JSON.stringify(args ?? {}).length
    }
  }
  return chars
}

interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  cacheHitRate: number | null
  todayCost: number
}

/** The usage fields this footer totals, read structurally so no cast is needed. */
type UsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: { total: number }
}

function collectTotals(ctx: ExtensionContext, since: number): Totals {
  const totals: Totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: null,
    todayCost: 0,
  }
  // `usage` stays optional here even though an assistant message always carries it:
  // a truncated or hand-edited session file is the case this guard is for.
  const add = (usage: UsageTotals | undefined, assistant: boolean, isToday: boolean): void => {
    if (!usage) return
    totals.input += usage.input
    totals.output += usage.output
    totals.cacheRead += usage.cacheRead
    totals.cacheWrite += usage.cacheWrite
    totals.cost += usage.cost.total
    if (isToday) totals.todayCost += usage.cost.total
    if (!assistant) return
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    if (prompt > 0) totals.cacheHitRate = (usage.cacheRead / prompt) * 100
  }
  for (const entry of ctx.sessionManager.getEntries()) {
    const stamp =
      'timestamp' in entry && typeof entry.timestamp === 'string'
        ? Date.parse(entry.timestamp)
        : Number.NaN
    const isToday = Number.isFinite(stamp) && stamp >= since
    if (entry.type === 'message') {
      const { message } = entry
      if (message.role === 'assistant') add(message.usage, true, isToday)
      else if (message.role === 'toolResult') add(message.usage, false, isToday)
      continue
    }
    // Compaction and branch summaries bill a model call of their own.
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      add(entry.usage, false, isToday)
    }
  }
  return totals
}

/** Tokens per character, averaged over recent assistant messages with provider usage. */
function seedRatio(ctx: ExtensionContext): number | null {
  const samples: number[] = []
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    const output = entry.message.usage.output
    const chars = blockChars(entry.message.content)
    if (output <= 0 || chars <= 0) continue
    samples.push(output / chars)
    if (samples.length >= 5) break
  }
  if (samples.length === 0) return null
  return samples.reduce((sum, value) => sum + value, 0) / samples.length
}

export default function (pi: ExtensionAPI) {
  let ratio: number | null = null
  let requestRender: (() => void) | null = null
  let currency: Currency = USD

  // Latest turn reading: { rate, exact, ttftMs }
  let reading: { rate: number; exact: boolean; ttftMs: number | null } | null = null

  // Breakdown-line inputs, refreshed once per turn rather than per frame. The prompt and the
  // tool list change only across turns (before_agent_start re-captures both), and the message
  // estimate only changes when the branch's leaf does, so the footer's per-frame work is
  // string assembly over cached numbers.
  let detailVisible = false
  let promptParts: PromptBreakdown | null = null
  let toolSplit: ToolSplit | null = null
  let reserveTokens: number | null = null
  let messagesCache: { leafId: string | null; tokens: number } | null = null

  /** Re-splits the rendered system prompt into its files, skills and remaining shares. */
  function refreshPrompt(prompt: string): void {
    promptParts = promptBreakdown(prompt)
  }

  /** Re-costs the tools actually sent to the provider: only the active ones cost anything. */
  function refreshTools(): void {
    toolSplit = splitToolTokens(pi.getAllTools(), pi.getActiveTools())
  }

  /** Conversation estimate, recomputed only when the branch's leaf entry has changed. */
  function messagesFor(ctx: ExtensionContext): number {
    const leafId = ctx.sessionManager.getLeafId() ?? null
    if (messagesCache === null || messagesCache.leafId !== leafId) {
      messagesCache = { leafId, tokens: messagesTokens(ctx.sessionManager.buildContextEntries()) }
    }
    return messagesCache.tokens
  }

  /** Flips the breakdown line and remembers the choice in the config file. */
  function setDetailVisible(value: boolean): void {
    detailVisible = value
    void (async () => {
      try {
        const text = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}')
        const updated = withDetailFlag(text, value)
        if (updated !== null) {
          await mkdir(STATUSLINE_DIR, { recursive: true })
          await writeFile(CONFIG_PATH, updated)
        }
      } catch {
        // The toggle still works this session; only its memory across sessions is lost.
      }
    })()
    requestRender?.()
  }

  /** Reads pi's compaction reserve from settings; null hides the slot (compaction off). */
  async function loadReserve(): Promise<number | null> {
    try {
      const config: unknown = JSON.parse(
        await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'),
      )
      // No compaction block is the normal case and means pi's defaults: enabled, reserving 16,384.
      // Treating it as "compaction off" hid the buffer for everyone who never touched settings.
      const compaction = isRecord(config) && isRecord(config.compaction) ? config.compaction : {}
      if (compaction.enabled === false) return null
      const reserve = compaction.reserveTokens
      if (typeof reserve === 'number' && Number.isFinite(reserve) && reserve > 0) return reserve
      return DEFAULT_RESERVE_TOKENS
    } catch {
      return DEFAULT_RESERVE_TOKENS
    }
  }

  let chars = 0
  let requestAt: number | null = null
  let firstTokenAt: number | null = null
  let totalDecodeMs = 0
  let totalMeasuredOutput = 0
  let totalTtftMs = 0
  let ttftCount = 0
  let todayBase = 0
  /** Last context usage pi reported with real numbers, shown when pi's current answer is stale. */
  let lastKnownUsage: {
    tokens: number | null
    percent: number | null
    contextWindow: number
  } | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let windowAt = 0
  let windowTokens = 0
  let renderedAt = 0

  function resetStream(): void {
    chars = 0
    firstTokenAt = null
    windowAt = 0
    windowTokens = 0
    renderedAt = 0
  }

  function publish(rate: number, exact: boolean, ttft: number | null): void {
    reading = { rate, exact, ttftMs: ttft }
    requestRender?.()
  }

  /** Stops the live count; a frozen TTFT needs no clock. */
  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }

  /** Ticks the footer while a request is in flight, until the first token lands or the turn ends. */
  function startTicker(): void {
    if (ticker !== null) return
    ticker = setInterval(() => {
      if (requestAt === null || firstTokenAt !== null) {
        stopTicker()
        return
      }
      requestRender?.()
    }, TICK_MS)
  }

  /**
   * Writes the throughput metrics so a /reload can restore them.
   *
   * Decode timing only exists in live stream events — pi records nothing per message — so without
   * this file the session's averages reset to zero every time the extension re-loads.
   */
  function persist(sessionFile: string | null): void {
    if (sessionFile === null) return
    const state = {
      sessionFile,
      totalDecodeMs,
      totalMeasuredOutput,
      totalTtftMs,
      ttftCount,
      last: reading,
    }
    void mkdir(STATE_DIR, { recursive: true })
      .then(() => writeFile(statePath(sessionFile), `${JSON.stringify(state, null, 2)}\n`))
      .catch(() => {})
  }

  /** Restores this session's own state file, written by persist before the reload. */
  async function restore(sessionFile: string | null): Promise<void> {
    if (sessionFile === null) return
    let state: unknown
    try {
      state = JSON.parse(await readFile(statePath(sessionFile), 'utf8'))
    } catch {
      return
    }
    if (!isRecord(state)) return
    totalDecodeMs = num(state.totalDecodeMs)
    totalMeasuredOutput = num(state.totalMeasuredOutput)
    totalTtftMs = num(state.totalTtftMs)
    ttftCount = num(state.ttftCount)
    if (isRecord(state.last) && typeof state.last.rate === 'number') {
      reading = {
        rate: state.last.rate,
        exact: state.last.exact === true,
        ttftMs: typeof state.last.ttftMs === 'number' ? state.last.ttftMs : null,
      }
    }
  }

  function installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender()

      return {
        invalidate() {},
        dispose() {
          requestRender = null
        },
        render(width: number): string[] {
          const usage = ctx.getContextUsage()
          // pi nulls tokens and percent when the last usage predates a compaction and no response
          // has landed since: the numbers it could hand over are stale, not zero. Show the last
          // reading we trusted instead; a brand-new session starts at 0, which is near the truth.
          const trusted =
            usage !== undefined && usage.tokens !== null && usage.percent !== null ? usage : null
          if (trusted !== null) lastKnownUsage = trusted
          const shown = trusted ?? lastKnownUsage
          const totals = collectTotals(ctx, startOfToday())
          const avg = avgTokPerSec(totalMeasuredOutput, totalDecodeMs)
          const row1 = contextRow(
            theme,
            width,
            {
              percent: shown?.percent ?? 0,
              tokens: shown?.tokens ?? 0,
              window: usage?.contextWindow ?? shown?.contextWindow ?? ctx.model?.contextWindow ?? 0,
              input: totals.input,
              output: totals.output,
              cacheHitRate: totals.cacheHitRate,
              cost: totals.cost,
              todayCost: todayBase + totals.todayCost,
            },
            currency,
          )

          // The breakdown panel sits directly under the meter it explains, before the identity
          // row. The concise footer renders by default; ctrl+e or /breakdown opens the panel.
          let breakdown: string[] | null = null
          if (detailVisible) {
            const window =
              usage?.contextWindow ?? shown?.contextWindow ?? ctx.model?.contextWindow ?? 0
            const used = shown?.tokens ?? 0
            const free = window > 0 ? Math.max(0, window - used - (reserveTokens ?? 0)) : null
            breakdown = breakdownPanel(theme, width, {
              messages: messagesFor(ctx),
              promptParts,
              toolSplit,
              reserve: reserveTokens,
              free,
              usedPercent: shown?.percent ?? null,
              window,
              used,
            })
          }

          // Row 2: model and the latest turn's timing on the right, path on the left. Three
          // groups — identity, first token, throughput — separated by a wall instead of another
          // dot, because a run of similar-looking pairs is what made the old footer unreadable.
          const model = ctx.model?.id ?? 'no model'
          const separator = theme.fg('dim', '  ·  ')
          const wall = theme.fg('dim', '  |  ')
          const identity = [theme.fg('accent', model)]
          if (ctx.thinkingLevel) identity.push(pair(theme, 'Effort', ctx.thinkingLevel))

          const ttft: string[] = []
          const waiting = ttftDisplay(requestAt, firstTokenAt, Date.now())
          if (waiting !== null) {
            // The clock is running: this wait has no reading yet, so the previous turn's
            // numbers would only be mistaken for the current one.
            ttft.push(pair(theme, 'TTFT', waiting.text))
          } else if (reading) {
            if (reading.ttftMs !== null)
              ttft.push(pair(theme, 'TTFT', formatLatency(reading.ttftMs)))
          }
          const avgTtft = avgMs(totalTtftMs, ttftCount)
          if (avgTtft !== null) ttft.push(pair(theme, 'Avg TTFT', formatLatency(avgTtft)))

          const throughput: string[] = []
          if (reading) {
            throughput.push(
              pair(theme, 'Last', `${reading.exact ? '' : '~'}${formatTps(reading.rate)} tok/s`),
            )
          }
          if (avg !== null) throughput.push(pair(theme, 'Avg', `${formatTps(avg)} tok/s`))

          const row2Right = [identity, ttft, throughput]
            .filter((group) => group.length > 0)
            .map((group) => group.join(separator))
            .join(wall)
          const branch = footerData.getGitBranch()
          const path = formatCwd(ctx.cwd)
          const branchSuffix = branch ? ` (${branch})` : ''
          // The model and the live reading matter more than the full path.
          const rightW2 = visibleWidth(row2Right)
          const room = width - rightW2 - 2
          let pwdPlain = ''
          if (room >= 10) {
            if (path.length + branchSuffix.length <= room) {
              pwdPlain = path + branchSuffix
            } else {
              // Shorten the path first; drop the branch only if it still will not fit.
              const withBranch =
                shortenPath(path, Math.max(1, room - branchSuffix.length)) + branchSuffix
              pwdPlain = withBranch.length <= room ? withBranch : shortenPath(path, room)
            }
          }
          const row2Left = pwdPlain ? theme.fg('muted', pwdPlain) : ''

          const lines =
            breakdown === null
              ? [row1, row(theme, width, row2Left, row2Right)]
              : [row1, ...breakdown, row(theme, width, row2Left, row2Right)]

          // Other extensions' status entries still belong on screen, minus the
          // ones that only report that nothing is happening.
          const visibleStatuses = [...footerData.getExtensionStatuses().entries()]
            .filter(([key, value]) => !isQuietStatus(key, value))
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([, value]) => value.replace(/[\r\n\t]+/g, ' ').trim())
            .join('  ')
          if (visibleStatuses)
            lines.push(truncateToWidth(visibleStatuses, width, theme.fg('dim', '...')))
          return lines
        },
      }
    })
  }

  // A run that ends without a first token (abort, provider error) must not leave a clock counting
  // against a request that is no longer in flight.
  pi.on('turn_end', async () => {
    requestAt = null
    stopTicker()
  })

  pi.on('agent_end', async () => {
    requestAt = null
    stopTicker()
  })

  pi.on('agent_settled', async () => {
    requestAt = null
    stopTicker()
  })

  // The prompt and the tool list are inputs to the breakdown line, and both are settled by the
  // time this fires: earlier handlers have chained their changes, so what is captured here is
  // what this turn actually sends. A later handler can still mutate it, which would only make
  // the buckets estimates of an estimate — the same honesty the panel already carries.
  pi.on('before_agent_start', async (event) => {
    refreshPrompt(event.systemPrompt)
    refreshTools()
  })

  pi.on('session_start', async (_event, ctx) => {
    ratio = seedRatio(ctx)
    reading = null
    requestAt = null
    totalDecodeMs = 0
    totalMeasuredOutput = 0
    stopTicker()
    resetStream()
    currency = await loadCurrency((message) => ctx.ui.notify(message, 'warning'))
    lastKnownUsage = null
    await migrateLegacyFile(LEGACY_CONFIG, CONFIG_PATH)
    await migrateLegacyState(LEGACY_STATE)
    await migrateLegacyState(LEGACY_SHARED_STATE)
    void pruneState()
    const file = ctx.sessionManager.getSessionFile()
    await restore(file ?? null)
    todayBase = await sumOtherTodaysCost(file ?? null, startOfToday())

    // Breakdown inputs. The prompt is read once so the line exists before the first turn;
    // from there before_agent_start keeps it current.
    refreshPrompt(ctx.getSystemPrompt())
    refreshTools()
    reserveTokens = await loadReserve()
    detailVisible = await (async () => {
      try {
        return detailFromConfig(await readFile(CONFIG_PATH, 'utf8'))
      } catch {
        return false
      }
    })()

    installFooter(ctx)
  })

  pi.on('message_start', async (event) => {
    if (event.message.role !== 'assistant') return
    resetStream()
  })

  // TTFT's request anchor, from the agent loop in pi's docs: turn_start opens the LLM call and
  // before_provider_request is the last thing pi does before the wire. message_start is not that
  // moment, and anchoring there made a first token that arrived early read as a clamped 0ms.
  pi.on('turn_start', async () => {
    requestAt = null
  })

  pi.on('before_provider_request', async () => {
    requestAt = Date.now()
  })

  pi.on('turn_start', async () => {
    requestAt = null
    stopTicker()
  })

  pi.on('before_provider_request', async () => {
    requestAt = Date.now()
    startTicker()
  })

  pi.on('message_update', async (event) => {
    const delta = event.assistantMessageEvent
    // Narrowing on the discriminant is what keeps the payload typed; membership in
    // a Set of strings tells the compiler nothing.
    if (
      delta.type !== 'text_delta' &&
      delta.type !== 'thinking_delta' &&
      delta.type !== 'toolcall_delta'
    ) {
      return
    }

    const now = Date.now()
    if (firstTokenAt === null) {
      firstTokenAt = now
      stopTicker()
    }
    chars += delta.delta.length

    const tokens = chars * (ratio ?? FALLBACK_TOKENS_PER_CHAR)
    if (windowAt === 0 || now - windowAt > WINDOW_MS) {
      windowAt = now
      windowTokens = tokens
    }

    const decodeMs = now - firstTokenAt
    if (decodeMs < MIN_SAMPLE_MS || now - renderedAt < LIVE_RENDER_MS) return

    const windowMs = now - windowAt
    const rate =
      windowMs > 0 ? ((tokens - windowTokens) / windowMs) * 1000 : (tokens / decodeMs) * 1000
    renderedAt = now
    publish(rate, false, ttftMs(requestAt, firstTokenAt))
  })

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return

    const message = event.message as { content: unknown; usage?: { output?: number } }
    const output = message.usage?.output ?? 0
    const totalChars = blockChars(message.content)
    if (output > 0 && totalChars > 0) {
      const sample = output / totalChars
      ratio = ratio === null ? sample : (ratio + sample) / 2
    }

    const decodeMs = firstTokenAt !== null ? Date.now() - firstTokenAt : 0
    const measured = ttftMs(requestAt, firstTokenAt)
    const tokens = output > 0 ? output : totalChars * (ratio ?? FALLBACK_TOKENS_PER_CHAR)
    if (measured !== null && decodeMs >= MIN_SAMPLE_MS) {
      // The average's numerator and denominator must cover the same messages: totals.output spans
      // the whole session (a reload replays none of it), so pairing it with the partial denominator
      // below once produced an Avg of 4324 tok/s.
      totalDecodeMs += decodeMs
      if (output > 0) totalMeasuredOutput += output
      totalTtftMs += measured
      ttftCount += 1
      persist(ctx.sessionManager.getSessionFile() ?? null)
      publish((tokens / decodeMs) * 1000, output > 0, measured)
    } else if (measured !== null && decodeMs > 0) {
      // The frozen Last must be this message's whole-message rate, never the last live
      // sliding-window sample: a buffered burst of chunks mid-stream reads triple.
      publish((tokens / decodeMs) * 1000, output > 0, measured)
    }
    // Null it with the stream: a request that has produced its message is no longer in flight, and
    // a stale anchor would let the live branch count against nothing until the next turn.
    requestAt = null
    resetStream()
  })

  // The breakdown panel is opt-in: the concise footer stays the default. Both toggles remember
  // the choice in the config file. ctrl+e is unbound across pi's default keymaps and in every
  // extension installed on this machine; if another extension owns it here, BREAKDOWN_SHORTCUT
  // is the one place to move it.
  pi.registerShortcut(BREAKDOWN_SHORTCUT, {
    description: 'Toggle the context breakdown panel in the status line',
    handler: () => {
      setDetailVisible(!detailVisible)
    },
  })
  pi.registerCommand('breakdown', {
    description: 'Toggle the context breakdown panel in the status line',
    handler: async () => {
      setDetailVisible(!detailVisible)
    },
  })
}
