/**
 * Pure rendering helpers for the status line: number formatting, the context meter, the two-group
 * row layout, and the status-noise filter.
 *
 * Nothing here touches pi APIs, the filesystem, or the clock, so every export is a function of its
 * arguments alone and is covered by render.test.ts.
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

/** Three decimals, with one trailing zero trimmed so `$0.380` renders as `$0.38`. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(3).replace(/0$/, '')}`
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
