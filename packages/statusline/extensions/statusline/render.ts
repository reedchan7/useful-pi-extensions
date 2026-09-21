/**
 * Pure rendering helpers for the status line: number formatting, the context meter, the two-group
 * row layout, the status-noise filter, and the display currency.
 *
 * Nothing here touches pi APIs, the filesystem, or the clock, so every export is a function of its
 * arguments alone and is covered by render.test.ts. The config file is read by the caller and
 * handed in as text, which is what keeps the parsing testable here.
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/**
 * Meter geometry, copied from cli-progress's `shades_classic` preset (10M downloads/week): block
 * fill, shaded block track. Its one structural rule is that the bar is a FIXED width (`barsize`,
 * default 40) and never stretches to the row. An earlier revision here stretched it to the
 * terminal, which is what made it read as chrome rather than as an instrument. 20 cells is the
 * footer-sized equivalent.
 */
export const BAR_CELLS = 20
export const BAR_FILL = '█'
/**
 * Set to '' for a trackless bar, or '─' for a hairline track. Annotated `string` rather than left
 * as its literal type, so the empty case below is a real branch.
 */
export const BAR_TRACK: string = '░'

/** 1/8-cell fill ladder (U+258F..U+2588) for a smooth leading edge. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** Strip ANSI so status text can be pattern-matched on its visible form. */
// eslint-disable-next-line no-control-regex -- matching an ANSI escape requires the ESC character
export const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Status entries that only report that nothing is happening. Other extensions set these
 * persistently; they cost a row without carrying information. Matching is keyed by status key, so
 * an unrelated extension that happens to use the same words is left alone.
 */
export const QUIET_STATUS: ReadonlyArray<readonly [string, RegExp]> = [
  // pi-lens reports language-server health here. Useful when diagnostics break; permanent
  // noise once they work, so the whole LSP line stays out of the footer.
  ['pi-lens-lsp', /^LSP/i],
]

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/** Whole tokens from ten up, one decimal below (matches the harness formatter). */
export function formatTps(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Milliseconds below a second, seconds with one decimal under ten, whole seconds from there. */
export function formatLatency(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 1000) return `${Math.round(clamped)}ms`
  const seconds = clamped / 1000
  // Fixed one decimal under 10s: dropping the ".0" costs two columns, and the whole row would
  // twitch every time a ticking count crossed an integer.
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
}

/**
 * TTFT from its two wall-clock anchors: the moment the request was dispatched, and the first
 * streamed delta.
 *
 * The guard is the point. Both anchors come from extension events whose ordering around a stream is
 * not guaranteed, and a first token that appears to precede its own request yields a negative that
 * `formatLatency` would clamp to `0ms` — a confident fake where an honest absence belongs.
 *
 * @returns The milliseconds between the two, or null when they do not line up.
 */
export function ttftMs(requestAt: number | null, firstTokenAt: number | null): number | null {
  if (requestAt === null || firstTokenAt === null) return null
  return firstTokenAt > requestAt ? firstTokenAt - requestAt : null
}

/**
 * The frozen Last throughput for a finished message: its whole-message rate, output tokens over the
 * entire decode window.
 *
 * A decode window below the sample floor is a burst arrival — the whole message landed in one or
 * two chunks, so there is no decode phase to measure. Dividing by those couple of milliseconds once
 * printed `Last 82000 tok/s` for an 82-token greeting; like the negative TTFT above, an
 * unmeasurable rate reports absence rather than a confident fake.
 *
 * @param decodeMs - Milliseconds from the first streamed delta to message end.
 * @param tokens - Output tokens for the message (provider-reported when available).
 * @param minSampleMs - The shortest window considered a real decode phase.
 * @returns The tokens/second rate, or null when the window is too short to measure.
 */
export function frozenThroughput(
  decodeMs: number,
  tokens: number,
  minSampleMs: number,
): number | null {
  if (decodeMs < minSampleMs) return null
  return (tokens / decodeMs) * 1000
}

/** What the TTFT slot renders, and whether the clock is still running. */
export interface TtftDisplay {
  text: string
  live: boolean
}

/**
 * The TTFT slot, for all three phases of a request.
 *
 * While the request is in flight the slot counts up (`~2s`, the `~` marking an unfinished wait, the
 * same convention as the tok/s estimate) — a slow first byte is something you watch happen, not a
 * number you are told about afterwards. The moment the first token lands the count freezes into the
 * exact value. With no request in flight there is nothing to show.
 *
 * @param now - The clock, passed in so every branch stays a function of its arguments.
 */
export function ttftDisplay(
  requestAt: number | null,
  firstTokenAt: number | null,
  now: number,
): TtftDisplay | null {
  if (requestAt === null) return null
  if (firstTokenAt === null) {
    if (now < requestAt) return null
    return { text: `~${formatLatency(now - requestAt)}`, live: true }
  }
  const measured = ttftMs(requestAt, firstTokenAt)
  return measured === null ? null : { text: formatLatency(measured), live: false }
}

/** Home-relative path, or the absolute path when it is outside the home directory. */
export function formatCwd(cwd: string): string {
  const home = homedir()
  if (!home) return cwd
  try {
    const rel = relative(resolve(home), resolve(cwd))
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    if (!inside) return cwd
    return rel === '' ? '~' : `~${sep}${rel}`
  } catch {
    return cwd
  }
}

/**
 * A display currency: the symbol to print, and how many of its units one USD buys.
 *
 * Pi prices every model in USD and never names a unit — its own model type documents `cost` as
 * "cost per million tokens" — so a conversion rate cannot be derived from pi and has to come from
 * the person paying. What a session cost in RMB is set by whoever sold the credit, not by a market
 * feed, which is why the rate is configured rather than fetched. See README.md for the file.
 */
export interface Currency {
  symbol: string
  perUsd: number
}

/** What the footer shows until the config file names something else. */
export const USD: Currency = { symbol: '$', perUsd: 1 }

/** Currencies the config can name by `code` alone. Anything else needs an explicit `symbol`. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  AUD: 'A$',
  CAD: 'CA$',
  CHF: 'CHF',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  INR: '₹',
  // ¥ is CNY's by default; JPY wears the prefixed form so the two never trade places.
  JPY: 'JP¥',
  KRW: '₩',
  NZD: 'NZ$',
  RMB: '¥',
  SGD: 'S$',
  TWD: 'NT$',
  USD: '$',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The identity a currency block asks for: the API code and the symbol to print. */
interface CurrencyIdentity {
  code: string
  symbol: string
}

function currencyIdentity(raw: Record<string, unknown>): CurrencyIdentity | null {
  const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : ''
  const explicit = typeof raw.symbol === 'string' ? raw.symbol : ''
  const symbol = explicit || CURRENCY_SYMBOLS[code] || code
  return symbol === '' ? null : { code, symbol }
}

/**
 * Validates a `currency` block.
 *
 * A rate that is missing, zero, negative or not a number is refused rather than defaulted: a
 * confident wrong amount is worse than the unconverted one the caller falls back to.
 *
 * @param raw - The `currency` value from a parsed config file.
 * @returns The currency, or null when the block could not be used.
 */
export function parseCurrency(raw: unknown): Currency | null {
  if (!isRecord(raw)) return null
  const rate = raw.perUsd
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  const identity = currencyIdentity(raw)
  return identity === null ? null : { symbol: identity.symbol, perUsd: rate }
}

/** A currency, plus what to do when the config named one without a rate of its own. */
export interface CurrencyConfig {
  currency: Currency
  /** Set when the block names a code but no rate: the rate comes from a daily fetch. */
  pending: { code: string; symbol: string } | null
  problem: string | null
}

/**
 * The display currency a config file asks for.
 *
 * A block with `perUsd` is a rate the user pinned, and is used as it is. A block with only a `code`
 * asks for the market rate, which the caller fetches once a day — this returns what to fetch and
 * the symbol to spend it with, and the caller decides what a failed fetch falls back to.
 *
 * @param text - The contents of the config file, or null when it does not exist. Absent is the
 *   normal case and is not a problem; a file that is there but unusable is, because the footer
 *   would otherwise keep showing dollars with nothing to explain it.
 */
export function currencyFromConfig(text: string | null): CurrencyConfig {
  if (text === null) return { currency: USD, pending: null, problem: null }
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return {
      currency: USD,
      pending: null,
      problem: 'statusline.json is not valid JSON, showing USD',
    }
  }
  if (!isRecord(config) || !Object.hasOwn(config, 'currency')) {
    return { currency: USD, pending: null, problem: null }
  }
  if (!isRecord(config.currency)) {
    return {
      currency: USD,
      pending: null,
      problem: 'statusline.json currency needs a code with a rate, or perUsd, showing USD',
    }
  }
  const identity = currencyIdentity(config.currency)
  const rate = config.currency.perUsd
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    return {
      currency: { symbol: identity?.symbol ?? '$', perUsd: rate },
      pending: null,
      problem: null,
    }
  }
  if (identity !== null && !Object.hasOwn(config.currency, 'perUsd')) {
    return { currency: USD, pending: identity, problem: null }
  }
  return {
    currency: USD,
    pending: null,
    problem: 'statusline.json currency needs a code with a rate, or perUsd, showing USD',
  }
}

/** The day's rates out of an open.er-api.com payload, positive and finite only. */
export function ratesFromPayload(payload: unknown): Record<string, number> {
  if (!isRecord(payload) || !isRecord(payload.rates)) return {}
  const rates: Record<string, number> = {}
  for (const [code, rate] of Object.entries(payload.rates)) {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate
  }
  return rates
}

/** The rates a config file cached from an earlier fetch, and the day they were fetched. */
export function cachedRates(
  text: string,
): { rates: Record<string, number>; fetchedAt: string } | null {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(config) || !isRecord(config.rates)) return null
  const fetchedAt = config.fetchedAt
  if (typeof fetchedAt !== 'string') return null
  const rates: Record<string, number> = {}
  for (const [code, rate] of Object.entries(config.rates)) {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate
  }
  return Object.keys(rates).length === 0 ? null : { rates, fetchedAt }
}

/** Whether a cached rate was fetched today, both dates as `YYYY-MM-DD`. */
export function cacheIsFresh(fetchedAt: string, today: string): boolean {
  return fetchedAt.slice(0, 10) === today
}

/** Session-average output tokens per second of measured decode time; null before any measurement. */
export function avgTokPerSec(outputTokens: number, decodeMs: number): number | null {
  if (decodeMs <= 0) return null
  return outputTokens / (decodeMs / 1000)
}

/** Mean of `count` durations totalling `totalMs`; null when nothing was measured. */
export function avgMs(totalMs: number, count: number): number | null {
  return count > 0 ? totalMs / count : null
}

/**
 * The config file's text with the day's rates recorded in it, so the next session starts warm.
 *
 * Unknown keys are kept, and a file that does not parse is returned untouched: the extension has no
 * business replacing a config it could not read with one it wrote.
 */
export function withCachedRates(
  text: string,
  rates: Record<string, number>,
  fetchedAt: string,
): string {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return text
  }
  if (!isRecord(config)) return text
  return `${JSON.stringify({ ...config, rates, fetchedAt }, null, 2)}\n`
}

/**
 * Two decimals, with the padding zeros trimmed so `$0.30` renders as `$0.3`.
 *
 * All of them, not just one: a converted amount lands on `¥17.80` often enough that a single
 * trailing zero would show up as `¥17.8` beside `¥2.71` and read as a different precision.
 *
 * A nonzero amount that rounds down to zero renders as a bounded floor, `<$0.01`, because `$0`
 * claims nothing was spent — the one thing a billing figure must never say.
 */
export function formatCost(cost: number, currency: Currency = USD): string {
  const amount = cost * currency.perUsd
  if (cost > 0 && Number(amount.toFixed(2)) === 0) return `<${currency.symbol}0.01`
  return `${currency.symbol}${amount.toFixed(2).replace(/\.?0+$/, '')}`
}

/**
 * Shorten a path from the left, keeping the tail that identifies the project. Never returns a
 * mid-word fragment: it degrades to `…/last` and then to `last…`.
 */
export function shortenPath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path
  const parts = path.split(sep).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = `…${sep}${parts.slice(i).join(sep)}`
    if (candidate.length <= maxWidth) return candidate
  }
  const tail = parts.at(-1) ?? path
  return tail.length <= maxWidth ? tail : `${tail.slice(0, Math.max(1, maxWidth - 1))}…`
}

/** Context pressure: accent is healthy, warning starts above 70%, error above 90%. */
export function barColor(fraction: number): ThemeColor {
  if (fraction > 0.9) return 'error'
  if (fraction > 0.7) return 'warning'
  return 'accent'
}

/** The same thresholds applied to the printed percentage. */
export function percentColor(percent: number | null): ThemeColor {
  if (percent === null) return 'text'
  if (percent > 90) return 'error'
  if (percent > 70) return 'warning'
  return 'text'
}

/**
 * Cli-progress's bar algorithm (`shades_classic`), plus a 1/8-cell leading edge so the fill grows
 * smoothly instead of jumping a whole cell at a time.
 */
export function bar(theme: Theme, cells: number, fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const scaled = clamped * cells
  const whole = Math.min(cells, Math.floor(scaled))
  const edge = whole < cells ? (EIGHTHS[Math.floor((scaled - whole) * 8)] ?? '') : ''
  const fill = theme.fg(barColor(clamped), BAR_FILL.repeat(whole) + edge)
  if (!BAR_TRACK) return fill
  return fill + theme.fg('dim', BAR_TRACK.repeat(Math.max(0, cells - whole - edge.length)))
}

/**
 * Left group and right group on one line, padded to `width`. When the two do not fit, the right
 * group is dropped rather than half rendered, so no number ever appears cut; the wider side keeps
 * the line when only one of them fits.
 */
export function row(theme: Theme, width: number, left: string, right: string): string {
  const leftWidth = visibleWidth(left)
  const rightWidth = right ? visibleWidth(right) : 0
  const gap = leftWidth > 0 && rightWidth > 0 ? 2 : 0
  if (rightWidth > 0 && leftWidth + gap + rightWidth <= width) {
    return left + ' '.repeat(Math.max(0, width - leftWidth - rightWidth)) + right
  }
  const keep = leftWidth > 0 ? left : right
  return truncateToWidth(keep, width, theme.fg('dim', '…'))
}

/** The row-1 figures, already totalled by the caller. */
export interface ContextRowParts {
  percent: number | null
  tokens: number
  window: number
  input: number
  output: number
  cacheHitRate: number | null
  cost: number
  /** Today's spend across every session on this machine, or 0 to hide the slot. */
  todayCost: number
}

/**
 * Row 1: context pressure on the left, session totals on the right.
 *
 * Space is given up in a fixed order rather than all at once, because this row carries numbers that
 * appear nowhere else in the footer. A narrower terminal costs, in turn:
 *
 * 1. The absolute `tokens / window` detail,
 * 2. The input/output volumes, which are informative but not bills,
 * 3. The cache-hit rate, which is diagnostic rather than money,
 * 4. Today's running total (the session's own bill outlives it),
 * 5. The bar's own cells, down to a stub — the percent survives everything.
 *
 * @param currency - Used for the cost; defaults to USD so the row renders without a config file.
 */
export function contextRow(
  theme: Theme,
  width: number,
  parts: ContextRowParts,
  currency: Currency = USD,
): string {
  const fraction = parts.percent === null ? 0 : parts.percent / 100
  const percent = theme.fg(
    percentColor(parts.percent),
    // Whole percents: the meter carries the precision, and a decimal here is noise.
    parts.percent === null ? '--' : `${Math.round(parts.percent)}%`,
  )
  // The title is Claude Code's: "Context window", so the two panels read the same at a glance.
  const meterWith = (cells: number): string =>
    `${theme.fg('dim', 'Context window')}  ${bar(theme, cells, fraction)}  ${percent}`
  const meter = meterWith(BAR_CELLS)
  const detail =
    parts.window > 0 ? `${formatTokens(parts.tokens)} / ${formatTokens(parts.window)}` : ''
  const withDetail = detail === '' ? meter : `${meter}   ${theme.fg('dim', detail)}`

  // Volume, then the numbers that describe what the session cost.
  const volumes: string[] = []
  if (parts.input > 0) volumes.push(pair(theme, 'Input', formatTokens(parts.input)))
  if (parts.output > 0) volumes.push(pair(theme, 'Output', formatTokens(parts.output)))
  const hit: string[] = []
  if (parts.cacheHitRate !== null) {
    hit.push(pair(theme, 'Cache hit', `${parts.cacheHitRate.toFixed(1)}%`))
  }
  const money: string[] = []
  if (parts.cost > 0) money.push(pair(theme, 'Cost', formatCost(parts.cost, currency)))
  if (parts.todayCost > 0) {
    money.push(pair(theme, 'Today', formatCost(parts.todayCost, currency)))
  }

  const separator = theme.fg('dim', '  ·  ')
  // Groups, not a flat run of dots: volumes | cache | money. A wall between different kinds of
  // number reads faster than another dot between similar-looking ones.
  const groups: string[] = []
  if (volumes.length > 0) groups.push(volumes.join(separator))
  if (hit.length > 0) groups.push(hit.join(separator))
  if (money.length > 0) groups.push(money.join(separator))
  const full = groups.join(theme.fg('dim', '  |  '))
  const core =
    hit.length > 0 && money.length > 0
      ? hit.join(separator) + theme.fg('dim', '  |  ') + money.join(separator)
      : [...hit, ...money].join(separator)
  const fits = (left: string, right: string): boolean =>
    right === '' || visibleWidth(left) + 2 + visibleWidth(right) <= width

  const moneyOnly = money.join(separator)
  // The session's own bill outlives today's running total.
  const ownBill = money.length > 0 ? (money[0] ?? '') : ''

  // The ladder, highest fidelity first: the detail, the volumes, the cache diagnostics and
  // today's total each give up their seat before the bar itself shrinks — twenty cells of bar
  // are a luxury the bills should not have to pay for.
  const compact = 10
  const rungs: Array<{ left: string; right: string }> = [
    { left: withDetail, right: full },
    { left: meter, right: full },
    { left: meter, right: core },
    { left: meter, right: moneyOnly },
    { left: meterWith(compact), right: moneyOnly },
    { left: meterWith(compact), right: ownBill },
  ]
  for (const { left, right } of rungs) {
    if (right === '' ? visibleWidth(left) <= width : fits(left, right)) {
      return row(theme, width, left, right)
    }
  }

  // Floor: the percent is the one number this row exists to show — the bar shrinks to a stub
  // before the percent is ever truncated, and past that the label goes, never the number.
  const stub = Math.min(compact, width - 22)
  if (stub >= 4) return row(theme, width, meterWith(stub), '')
  if (width >= 18) {
    return row(theme, width, `${theme.fg('dim', 'Context window')}  ${percent}`, '')
  }
  return truncateToWidth(percent, width, theme.fg('dim', '…'))
}

/** The row-2 right side, the caller pre-formatting each slot's display text. */
export interface TimingRowParts {
  model: string
  /** Thinking level label, or null to hide the slot. */
  effort: string | null
  /** The live TTFT clock or the frozen reading, or null to hide the slot. */
  ttft: string | null
  /** Session-average TTFT, or null to hide the slot. */
  avgTtft: string | null
  /** Last turn's decode rate, or null to hide the slot. */
  last: string | null
  /** Session-average decode rate, or null to hide the slot. */
  avg: string | null
}

/**
 * Row 2's right side: the model, the effort level, and the latest turn's timing.
 *
 * Like row 1, space is given up in a fixed order rather than half rendered. A narrower terminal
 * costs, in turn: the throughput average, the TTFT average, the effort level, the last rate —
 * aggregates before live numbers, static config before measured history. The model and the TTFT
 * clock are the floor; past them the line truncates, because a model id is the one string here with
 * no drop-in substitute.
 *
 * @returns The assembled right side, at most `width` cells wide.
 */
export function timingRow(theme: Theme, width: number, parts: TimingRowParts): string {
  const separator = theme.fg('dim', '  ·  ')
  const wall = theme.fg('dim', '  |  ')
  const slots = {
    model: theme.fg('accent', parts.model),
    effort: parts.effort !== null ? pair(theme, 'Effort', parts.effort) : null,
    ttft: parts.ttft !== null ? pair(theme, 'TTFT', parts.ttft) : null,
    avgTtft: parts.avgTtft !== null ? pair(theme, 'Avg TTFT', parts.avgTtft) : null,
    last: parts.last !== null ? pair(theme, 'Last', parts.last) : null,
    avg: parts.avg !== null ? pair(theme, 'Avg', parts.avg) : null,
  }

  type Droppable = 'effort' | 'ttft' | 'avgTtft' | 'last' | 'avg'
  const hidden = new Set<Droppable>()
  const assemble = (): string =>
    [
      [slots.model, hidden.has('effort') ? null : slots.effort],
      [hidden.has('ttft') ? null : slots.ttft, hidden.has('avgTtft') ? null : slots.avgTtft],
      [hidden.has('last') ? null : slots.last, hidden.has('avg') ? null : slots.avg],
    ]
      .map((group) => group.filter((slot): slot is string => slot !== null))
      .filter((group) => group.length > 0)
      .map((group) => group.join(separator))
      .join(wall)

  const ladder: Droppable[] = ['avg', 'avgTtft', 'effort', 'last']
  let right = assemble()
  for (const key of ladder) {
    if (visibleWidth(right) <= width) break
    hidden.add(key)
    right = assemble()
  }
  return truncateToWidth(right, width, theme.fg('dim', '…'))
}

/** `label value` where the key is quiet and the value is not. */
export function pair(theme: Theme, key: string, value: string, color: ThemeColor = 'text'): string {
  return `${theme.fg('dim', key)} ${theme.fg(color, value)}`
}

/** True when a status entry only reports that nothing is happening. */
export function isQuietStatus(key: string, value: unknown): boolean {
  const rule = QUIET_STATUS.find(([candidate]) => candidate === key)
  if (!rule) return false
  return rule[1].test(String(value).replace(ANSI, '').trim())
}

// ----------------------------------------------------------------------------
// Context breakdown
//
// Claude Code's context panel answers "what is occupying the window": messages, memory files,
// tools, skills, and what is left. pi exposes every ingredient through public API, and this
// section turns them into one footer line.
//
// The accounting rule is pi's own: every bucket is tokens = ceil(chars / 4), the same heuristic
// as estimateTokens in core/compaction. So every number here is an estimate, and the buckets
// differ from the row-1 total (which comes from provider usage) by the same margin pi's own
// estimate does. Claude Code's panel has the same property — its buckets also sum past its
// header total.
// ----------------------------------------------------------------------------

/** Tokens from characters, by pi's own chars/4 heuristic (estimateTokens in core/compaction). */
export function tokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

/** Images carry this many estimated characters each, pi's own ESTIMATED_IMAGE_CHARS. */
const IMAGE_CHARS = 4800

/**
 * Characters of message content: strings, text blocks, tool calls and image placeholders.
 *
 * @param imageChars - What one image block counts for. The breakdown panel pays pi's full estimate;
 *   the stream ratio passes 0, because images never arrive as streamed text and would dilute a
 *   tokens-per-character reading with phantom characters.
 */
export function contentChars(content: unknown, imageChars = IMAGE_CHARS): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const raw of content as unknown[]) {
    if (!isRecord(raw)) continue
    if (raw.type === 'text' && typeof raw.text === 'string') chars += raw.text.length
    else if (raw.type === 'thinking' && typeof raw.thinking === 'string')
      chars += raw.thinking.length
    else if (raw.type === 'image') chars += imageChars
    else if (raw.type === 'toolCall') {
      const name = typeof raw.name === 'string' ? raw.name.length : 0
      let args = 0
      try {
        args = JSON.stringify(raw.arguments ?? {}).length
      } catch {
        // A circular argument object is not worth a crash; count the rest.
      }
      chars += name + args
    }
  }
  return chars
}

/**
 * Tokens one context entry occupies in the window, mirroring pi's sessionEntryToContextMessages:
 * message entries count as their role renders, custom messages and compaction/branch summaries
 * count as the text replayed into context, and system messages count as zero because the prompt
 * bucket below already owns them (counting both would double the prompt).
 *
 * Reads structurally and returns 0 for anything it does not recognize, so a hand-edited session
 * file degrades to an underestimate instead of a crash.
 */
export function entryChars(entry: unknown): number {
  if (!isRecord(entry)) return 0
  if (entry.type === 'message') {
    const message = entry.message
    if (!isRecord(message)) return 0
    if (message.role === 'system') return 0
    return contentChars(message.content)
  }
  if (
    entry.type === 'custom_message' ||
    entry.type === 'compaction' ||
    entry.type === 'branch_summary'
  ) {
    return typeof entry.summary === 'string' ? entry.summary.length : contentChars(entry.content)
  }
  return 0
}

/** Tokens for a whole context-entry list, as `sessionManager.buildContextEntries()` returns. */
export function messagesTokens(entries: readonly unknown[]): number {
  let chars = 0
  for (const entry of entries) chars += entryChars(entry)
  return tokensFromChars(chars)
}

/**
 * The inner text and the full tagged span of one system-prompt section, or null when absent.
 *
 * Pi renders every section as `<tag>\n...\n</tag>` (buildSystemPromptSections), so a plain indexOf
 * pair is exact and cannot trip over regex metacharacters in the prompt.
 */
function sectionOf(prompt: string, tag: string): { inner: string; full: string } | null {
  const open = `<${tag}>\n`
  const close = `\n</${tag}>`
  const start = prompt.indexOf(open)
  if (start < 0) return null
  const contentStart = start + open.length
  const end = prompt.indexOf(close, contentStart)
  if (end < 0) return null
  return { inner: prompt.slice(contentStart, end), full: prompt.slice(start, end + close.length) }
}

/** How a system prompt splits into its context-file, skills and remaining shares. */
export interface PromptBreakdown {
  /** Context files (AGENTS.md and friends) inside the project_context section. */
  files: number
  fileCount: number
  /** The skills section, in tokens. */
  skills: number
  skillCount: number
  /** The rest of the prompt: identity, tool list, rules, docs, cwd, custom sections. */
  prompt: number
}

/**
 * Splits a rendered system prompt into shares, in tokens.
 *
 * The sections are cut out of the prompt text itself rather than rebuilt from systemPromptOptions,
 * so extension chains and section patches are all accounted for: what is measured is the exact text
 * the model receives.
 */
export function promptBreakdown(prompt: string): PromptBreakdown {
  const files = sectionOf(prompt, 'project_context')
  const skills = sectionOf(prompt, 'skills')
  let rest = prompt
  if (files !== null) rest = rest.replace(files.full, '')
  if (skills !== null) rest = rest.replace(skills.full, '')
  return {
    files: tokensFromChars(files?.inner.length ?? 0),
    fileCount: files === null ? 0 : files.inner.split('<project_instructions ').length - 1,
    skills: tokensFromChars(skills?.inner.length ?? 0),
    skillCount: skills === null ? 0 : skills.inner.split('<skill>').length - 1,
    prompt: tokensFromChars(rest.length),
  }
}

/** The shape of one entry from `pi.getAllTools()`, read structurally for tests. */
export interface ToolLike {
  name: string
  description: string
  parameters?: unknown
  sourceInfo?: { source?: string } | null
}

/** How active tools split into built-in and everything else. */
export interface ToolSplit {
  /** Built-in tool schemas, in tokens. */
  builtin: number
  /** How many built-in tools are active. */
  builtinCount: number
  /** Extension-, SDK- and MCP-registered tool schemas together, in tokens. */
  other: number
  otherCount: number
}

/** JSON envelope keys ("name", "description", "input_schema") around each tool schema, in chars. */
const TOOL_ENVELOPE_CHARS = 48

/** Tokens one tool's schema costs on the wire: name, description and parameter JSON. */
export function toolTokens(tool: ToolLike): number {
  let chars = tool.name.length + tool.description.length + TOOL_ENVELOPE_CHARS
  try {
    chars += JSON.stringify(tool.parameters ?? {}).length
  } catch {
    // A circular schema still costs its name and description; count those.
  }
  return tokensFromChars(chars)
}

/**
 * Splits the tools actually sent to the provider into built-in and the rest.
 *
 * Inactive tools cost nothing — the provider never sees them — so only names in `active` count. MCP
 * tools arrive registered by extensions, so they land in `other` with them; pi has no deferred-tool
 * concept that would keep a tool's schema out of the request.
 */
export function splitToolTokens(tools: readonly ToolLike[], active: readonly string[]): ToolSplit {
  const wanted = new Set(active)
  const split: ToolSplit = { builtin: 0, builtinCount: 0, other: 0, otherCount: 0 }
  for (const tool of tools) {
    if (!wanted.has(tool.name)) continue
    const tokens = toolTokens(tool)
    if (tool.sourceInfo?.source === 'builtin') {
      split.builtin += tokens
      split.builtinCount += 1
    } else {
      split.other += tokens
      split.otherCount += 1
    }
  }
  return split
}

/** The breakdown panel's figures, all in tokens and all estimates. */
export interface BreakdownParts {
  /** The conversation on the active branch. */
  messages: number
  /** Prompt anatomy from the latest capture; null until one exists. */
  promptParts: PromptBreakdown | null
  /** Active tools from the latest capture; null until one exists. */
  toolSplit: ToolSplit | null
  /** Tokens compaction keeps in reserve for the model's reply; null to hide the slot. */
  reserve: number | null
  /** Window minus usage minus reserve; null when the window is unknown. */
  free: number | null
  /** Used share of the window, 0-100; colors Free space with the meter's 70/90 thresholds. */
  usedPercent: number | null
  /** The context window the percentages are anchored to; percentages hide when unknown. */
  window: number
  /** Total used tokens — the hero figure the panel's rows explain. */
  used: number
}

/**
 * A quiet meter for one bucket's share of the window, in the row-1 meter's own glyphs — `█` fill on
 * `░` track — at whole cells only: the 1/8-cell edge read as stray vertical strokes at this size.
 * One fill color for every row; a bucket that fills the window is not thereby a warning.
 */
export function shareBar(
  theme: Theme,
  cells: number,
  fraction: number,
  fill: ThemeColor,
  track: ThemeColor,
): string {
  const whole = Math.min(cells, Math.floor(Math.max(0, Math.min(1, fraction)) * cells))
  return theme.fg(fill, BAR_FILL.repeat(whole)) + theme.fg(track, BAR_TRACK.repeat(cells - whole))
}

/**
 * The breakdown panel: what occupies the context window, and what remains — a plain data grid, one
 * row per figure, every column aligned, kinds separated by dim rules.
 *
 * The title is row 1's and appears nowhere else. Three groups, each a different kind of number,
 * each behind a rule: `Used`, the provider-reported total; the estimated buckets, ending with
 * `Unaccounted` so the books close (buckets are chars/4 estimates, Used is real, and the gap is
 * shown rather than hidden — buckets + Unaccounted = Used, and Used + Autocompact buffer + Free
 * space = the window); and what is kept back or still open. Free space is the remainder, not a
 * consumer, and the closed arithmetic is what says so. Counts ride on labels as `×N`; every value
 * is tokens; every percentage is a share of the window; and every row ends in the same muted share
 * bar — the row-1 meter's glyphs at half size — so magnitudes compare without reading a number and
 * without a single new visual device.
 *
 * Bucket names and their order follow Claude Code's panel. Ext tools is the one bucket CC has no
 * name for: pi's non-builtin tools come from extensions, the SDK and MCP together, so "MCP tools"
 * would mislabel most of them.
 */
export function breakdownPanel(theme: Theme, width: number, parts: BreakdownParts): string[] {
  const share = (tokens: number): number =>
    parts.window > 0 ? Math.min(1, tokens / parts.window) : 0
  const pctOf = (tokens: number): number | null =>
    parts.window > 0 ? (tokens / parts.window) * 100 : null

  type Row = {
    label: string
    tokens: number
    pct: number | null
    labelColor?: ThemeColor
    valueColor?: ThemeColor
  }
  // Destructured to zero, so the pushes below read in display order without nesting.
  const { files, fileCount, skills, skillCount, prompt } = parts.promptParts ?? {
    files: 0,
    fileCount: 0,
    skills: 0,
    skillCount: 0,
    prompt: 0,
  }
  const { builtin, builtinCount, other, otherCount } = parts.toolSplit ?? {
    builtin: 0,
    builtinCount: 0,
    other: 0,
    otherCount: 0,
  }

  const pressure = percentColor(parts.usedPercent)
  // Group 1: the real total — the number the estimates below are measured against.
  const total: Row[] = [
    {
      label: 'Used',
      tokens: parts.used,
      pct: parts.usedPercent,
      labelColor: 'text',
      valueColor: pressure,
    },
  ]
  // Group 2: the estimated buckets, in the Claude Code panel's order.
  const buckets: Row[] = [{ label: 'Messages', tokens: parts.messages, pct: pctOf(parts.messages) }]
  if (fileCount > 0)
    buckets.push({ label: `Memory files ×${fileCount}`, tokens: files, pct: pctOf(files) })
  if (builtin > 0) {
    buckets.push({
      label: builtinCount > 0 ? `System tools ×${builtinCount}` : 'System tools',
      tokens: builtin,
      pct: pctOf(builtin),
    })
  }
  if (otherCount > 0)
    buckets.push({ label: `Ext tools ×${otherCount}`, tokens: other, pct: pctOf(other) })
  if (skillCount > 0)
    buckets.push({ label: `Skills ×${skillCount}`, tokens: skills, pct: pctOf(skills) })
  if (prompt > 0) buckets.push({ label: 'System prompt', tokens: prompt, pct: pctOf(prompt) })
  // The estimates miss the real total by design; showing the miss keeps the column honest.
  const unaccounted = parts.used - (parts.messages + files + skills + prompt + builtin + other)
  if (unaccounted > 0) {
    buckets.push({
      label: 'Unaccounted',
      tokens: unaccounted,
      pct: pctOf(unaccounted),
      valueColor: 'dim',
    })
  }
  // Group 3: what is kept back, and what remains.
  const remaining: Row[] = []
  if (parts.reserve !== null && parts.reserve > 0) {
    remaining.push({
      label: 'Autocompact buffer',
      tokens: parts.reserve,
      pct: pctOf(parts.reserve),
    })
  }
  if (parts.free !== null) {
    remaining.push({
      label: 'Free space',
      tokens: parts.free,
      pct: pctOf(parts.free),
      valueColor: pressure,
    })
  }

  const groups = [total, buckets, remaining].filter((group) => group.length > 0)
  const labelWidth = Math.max(...groups.flat().map((bucket) => bucket.label.length))
  const barCells = 10
  // Column plan: inset(2) · label · gap(2) · tokens(7) · gap(2) · share(6) · gap(2) · bar(10).
  const gridWidth = labelWidth + 2 + 7 + 2 + 6 + 2 + barCells
  const clip = (line: string): string => truncateToWidth(line, width, theme.fg('dim', '…'))
  const rule = clip(`  ${theme.fg('dim', '─'.repeat(gridWidth))}`)

  const lines: string[] = []
  for (const group of groups) {
    // A rule between kinds — never around them: the kinds are what the rules are for.
    if (lines.length > 0) lines.push(rule)
    for (const bucket of group) {
      const label = theme.fg(bucket.labelColor ?? 'dim', bucket.label.padEnd(labelWidth + 2))
      const tokens = theme.fg(bucket.valueColor ?? 'text', formatTokens(bucket.tokens).padStart(7))
      const pct = (bucket.pct === null ? '—' : `${bucket.pct.toFixed(1)}%`).padStart(6)
      const meter =
        parts.window > 0
          ? `  ${shareBar(theme, barCells, share(bucket.tokens), 'muted', 'dim')}`
          : ''
      lines.push(clip(`  ${label}${tokens}  ${theme.fg(bucket.valueColor ?? 'text', pct)}${meter}`))
    }
  }
  return lines
}

/** Reads the config's `detail` flag: the concise footer unless the file asks for the panel. */
export function detailFromConfig(text: string | null): boolean {
  if (text === null) return false
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return false
  }
  return isRecord(config) && config.detail === true
}

/**
 * The config file's text with `detail` set, or null when the file cannot be parsed — the extension
 * has no business replacing a config it could not read with one it wrote.
 */
export function withDetailFlag(text: string, value: boolean): string | null {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(config)) return null
  return `${JSON.stringify({ ...config, detail: value }, null, 2)}\n`
}
