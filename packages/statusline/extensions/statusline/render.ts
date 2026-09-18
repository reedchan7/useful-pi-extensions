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
  ['pi-lens-lsp', /^LSP Inactive$/i],
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
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)}s`
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
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  INR: '₹',
  JPY: '¥',
  KRW: '₩',
  RMB: '¥',
  SGD: 'S$',
  TWD: 'NT$',
  USD: '$',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : ''
  const explicit = typeof raw.symbol === 'string' ? raw.symbol : ''
  const symbol = explicit || CURRENCY_SYMBOLS[code] || code
  return symbol === '' ? null : { symbol, perUsd: rate }
}

/** A currency, plus the message to show when the config named one that could not be used. */
export interface CurrencyConfig {
  currency: Currency
  problem: string | null
}

/**
 * The display currency a config file asks for.
 *
 * @param text - The contents of the config file, or null when it does not exist. Absent is the
 *   normal case and is not a problem; a file that is there but unusable is, because the footer
 *   would otherwise keep showing dollars with nothing to explain it.
 */
export function currencyFromConfig(text: string | null): CurrencyConfig {
  if (text === null) return { currency: USD, problem: null }
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return { currency: USD, problem: 'statusline.json is not valid JSON, showing USD' }
  }
  if (!isRecord(config) || !Object.hasOwn(config, 'currency')) {
    return { currency: USD, problem: null }
  }
  const currency = parseCurrency(config.currency)
  if (currency === null) {
    return {
      currency: USD,
      problem: 'statusline.json currency needs a positive perUsd, showing USD',
    }
  }
  return { currency, problem: null }
}

/** Three decimals, with one trailing zero trimmed so `$0.380` renders as `$0.38`. */
/**
 * Three decimals, with the padding zeros trimmed so `$0.380` renders as `$0.38`.
 *
 * All of them, not just one: a converted amount lands on `¥17.800` often enough that a single
 * trailing zero would show up as `¥17.80` beside `¥2.706` and read as a different precision.
 */
export function formatCost(cost: number, currency: Currency = USD): string {
  return `${currency.symbol}${(cost * currency.perUsd).toFixed(3).replace(/\.?0+$/, '')}`
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
}

/**
 * Row 1: context pressure on the left, session totals on the right.
 *
 * Space is given up in a fixed order rather than all at once, because this row carries numbers that
 * appear nowhere else in the footer. A narrower terminal should cost the least load-bearing of them
 * visibly rather than silently dropping the whole group:
 *
 * 1. The absolute `tokens / window` detail,
 * 2. The input/output volumes, which are informative but not cumulative bills,
 * 3. The right group entirely (`row` then keeps the left alone).
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
    parts.percent === null ? '?' : `${parts.percent.toFixed(1)}%`,
  )
  const meter = `${theme.fg('dim', 'Context')}  ${bar(theme, BAR_CELLS, fraction)}  ${percent}`
  const detail =
    parts.window > 0 ? `${formatTokens(parts.tokens)} / ${formatTokens(parts.window)}` : ''
  const withDetail = detail === '' ? meter : `${meter}   ${theme.fg('dim', detail)}`

  // Volume, then the numbers that describe what the session cost.
  const volumes: string[] = []
  if (parts.input > 0) volumes.push(pair(theme, 'Input', formatTokens(parts.input)))
  if (parts.output > 0) volumes.push(pair(theme, 'Output', formatTokens(parts.output)))
  const outcomes: string[] = []
  if (parts.cacheHitRate !== null) {
    outcomes.push(pair(theme, 'Cache hit', `${parts.cacheHitRate.toFixed(1)}%`))
  }
  if (parts.cost > 0) outcomes.push(pair(theme, 'Cost', formatCost(parts.cost, currency)))

  const separator = theme.fg('dim', '  ·  ')
  const full = [...volumes, ...outcomes].join(separator)
  const core = outcomes.join(separator)
  const fits = (left: string, right: string): boolean =>
    right === '' || visibleWidth(left) + 2 + visibleWidth(right) <= width

  if (fits(withDetail, full)) return row(theme, width, withDetail, full)
  if (fits(meter, full)) return row(theme, width, meter, full)
  return row(theme, width, meter, core)
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
