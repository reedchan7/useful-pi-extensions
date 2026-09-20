/**
 * Unit tests for the pure rendering helpers.
 *
 * These encode the intent behind each helper, not just its arithmetic: the threshold tests pin the
 * boundary (70 and 90 are the values pi's own footer uses), the `row` tests pin the degradation
 * order (a half-rendered number is worse than a missing one), and the `isQuietStatus` tests pin
 * that filtering is scoped to a status key rather than to the words inside it.
 */

import { describe, expect, test } from 'bun:test'

import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'

import {
  bar,
  barColor,
  contextRow,
  currencyFromConfig,
  formatCost,
  formatLatency,
  formatTokens,
  formatTps,
  isQuietStatus,
  parseCurrency,
  percentColor,
  row,
  shortenPath,
  avgTokPerSec,
  cachedRates,
  ratesFromPayload,
  cacheIsFresh,
  withCachedRates,
  ttftDisplay,
  ttftMs,
  USD,
} from './render.ts'

/** Colour is invisible in these assertions, so the stub drops it. */
const plain = { fg: (_color: string, text: string) => text } as unknown as Theme
/** Keeps the colour name visible for the assertions that are about colour choice. */
const marked = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme

/** One run of meter glyphs, so an expectation reads as the bar and not as addition. */
const cells = (glyph: string, count: number): string => glyph.repeat(count)

describe('formatTokens', () => {
  test('keeps small counts exact and switches unit at each magnitude', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(9999)).toBe('10.0k')
    expect(formatTokens(10000)).toBe('10k')
    expect(formatTokens(471000)).toBe('471k')
    expect(formatTokens(1000000)).toBe('1.0M')
    expect(formatTokens(38000000)).toBe('38M')
  })
})

describe('formatTps', () => {
  test('gives whole tokens at ten and above, one decimal below', () => {
    // Matches deepseek-harness' formatTokensPerSecond, so pi and the harness agree.
    expect(formatTps(442.7)).toBe('443')
    expect(formatTps(10)).toBe('10')
    expect(formatTps(9.44)).toBe('9.4')
    expect(formatTps(-5)).toBe('0')
  })
})

describe('formatLatency', () => {
  test('stays in milliseconds below a second so small TTFTs keep their resolution', () => {
    expect(formatLatency(0)).toBe('0ms')
    expect(formatLatency(487)).toBe('487ms')
    expect(formatLatency(999)).toBe('999ms')
    expect(formatLatency(1000)).toBe('1s')
    expect(formatLatency(4820)).toBe('4.8s')
    expect(formatLatency(42000)).toBe('42s')
  })
})

describe('formatCost', () => {
  test('trims the padding zeros that toFixed(3) adds, all of them', () => {
    expect(formatCost(0.38)).toBe('$0.38')
    expect(formatCost(0.003)).toBe('$0.003')
    expect(formatCost(1.25)).toBe('$1.25')
    expect(formatCost(1.5)).toBe('$1.5')
    expect(formatCost(10)).toBe('$10')
  })

  test('converts at the configured rate, because pi only ever prices in USD', () => {
    const cny = { symbol: '¥', perUsd: 7.12 }
    expect(formatCost(1.612, cny)).toBe('¥11.477')
    expect(formatCost(0.38, cny)).toBe('¥2.706')
    // A converted amount must not read at a different precision than its neighbour.
    expect(formatCost(2.5, cny)).toBe('¥17.8')
    expect(formatCost(1, { symbol: 'HK$', perUsd: 7.8 })).toBe('HK$7.8')
  })
})

describe('parseCurrency', () => {
  test('takes a rate and derives the symbol from the code', () => {
    expect(parseCurrency({ code: 'CNY', perUsd: 7.12 })).toEqual({ symbol: '¥', perUsd: 7.12 })
    expect(parseCurrency({ code: 'cny', perUsd: 7.12 })).toEqual({ symbol: '¥', perUsd: 7.12 })
  })

  test('lets a symbol override the table, and falls back to the code when the table has none', () => {
    expect(parseCurrency({ code: 'XOF', symbol: 'F ', perUsd: 600 })).toEqual({
      symbol: 'F ',
      perUsd: 600,
    })
    expect(parseCurrency({ code: 'XOF', perUsd: 600 })).toEqual({ symbol: 'XOF', perUsd: 600 })
  })

  test('refuses a rate that is not a positive finite number', () => {
    // A confidently wrong amount is worse than the unconverted one the caller falls back to.
    expect(parseCurrency({ code: 'CNY' })).toBeNull()
    expect(parseCurrency({ code: 'CNY', perUsd: 0 })).toBeNull()
    expect(parseCurrency({ code: 'CNY', perUsd: -7 })).toBeNull()
    expect(parseCurrency({ code: 'CNY', perUsd: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseCurrency({ code: 'CNY', perUsd: '7.12' })).toBeNull()
    expect(parseCurrency({ perUsd: 7.12 })).toBeNull()
    expect(parseCurrency(null)).toBeNull()
    expect(parseCurrency('CNY')).toBeNull()
  })
})

describe('currencyFromConfig', () => {
  test('an absent file is the normal case and means USD', () => {
    expect(currencyFromConfig(null)).toEqual({ currency: USD, pending: null, problem: null })
  })

  test('a file with no currency block is not a problem to report', () => {
    expect(currencyFromConfig('{}')).toEqual({ currency: USD, pending: null, problem: null })
    expect(currencyFromConfig('{"theme":"dark"}')).toEqual({
      currency: USD,
      pending: null,
      problem: null,
    })
  })

  test('reads the configured currency', () => {
    expect(currencyFromConfig('{"currency":{"code":"CNY","perUsd":7.12}}')).toEqual({
      currency: { symbol: '¥', perUsd: 7.12 },
      pending: null,
      problem: null,
    })
  })

  test('a code without a rate asks for the market rate of the day', () => {
    const result = currencyFromConfig('{"currency":{"code":"CNY"}}')
    expect(result.currency).toEqual(USD)
    expect(result.pending).toEqual({ code: 'CNY', symbol: '¥' })
    expect(result.problem).toBeNull()
  })

  test('reports a file that exists but cannot be used', () => {
    // Falling back silently would leave the footer showing dollars with nothing to explain why.
    expect(currencyFromConfig('{ not json').problem).toContain('not valid JSON')
    expect(currencyFromConfig('{"currency":{"code":"CNY","perUsd":"7.1"}}').problem).toContain(
      'perUsd',
    )
    expect(currencyFromConfig('{ not json').currency).toEqual(USD)
  })
})

describe('ratesFromPayload', () => {
  test('keeps every positive finite rate and drops the rest', () => {
    expect(ratesFromPayload({ rates: { USD: 1, CNY: 7.12, JPY: -1, X: 'x' } })).toEqual({
      USD: 1,
      CNY: 7.12,
    })
    expect(ratesFromPayload({ result: 'success' })).toEqual({})
    expect(ratesFromPayload('nope')).toEqual({})
  })
})

describe('ratesFromPayload', () => {
  test('keeps every positive finite rate and drops the rest', () => {
    expect(ratesFromPayload({ rates: { USD: 1, CNY: 7.12, JPY: -1, X: 'x' } })).toEqual({
      USD: 1,
      CNY: 7.12,
    })
    expect(ratesFromPayload({ result: 'success' })).toEqual({})
    expect(ratesFromPayload('nope')).toEqual({})
  })
})

describe('cachedRates, cacheIsFresh and withCachedRates', () => {
  const file =
    '{"currency":{"code":"CNY"},"rates":{"CNY":7.14,"JPY":155.2},"fetchedAt":"2026-09-20"}'

  test('reads back the whole cached table, and refuses an empty or malformed one', () => {
    expect(cachedRates(file)).toEqual({
      rates: { CNY: 7.14, JPY: 155.2 },
      fetchedAt: '2026-09-20',
    })
    expect(cachedRates('{"rates":{"CNY":"7.14"},"fetchedAt":"2026-09-20"}')).toBeNull()
    expect(cachedRates('{}')).toBeNull()
  })

  test('a cache is fresh on the day it was fetched and stale the day after', () => {
    expect(cacheIsFresh('2026-09-20', '2026-09-20')).toBe(true)
    expect(cacheIsFresh('2026-09-20', '2026-09-21')).toBe(false)
  })

  test('writes the table back without disturbing the keys it does not own', () => {
    const updated = withCachedRates(file, { CNY: 7.15, JPY: 155.4 }, '2026-09-21')
    expect(cachedRates(updated)).toEqual({
      rates: { CNY: 7.15, JPY: 155.4 },
      fetchedAt: '2026-09-21',
    })
    expect(updated).toContain('"code": "CNY"')
  })

  test('never overwrites a file it could not parse', () => {
    expect(withCachedRates('{ not json', { CNY: 7.15 }, '2026-09-21')).toBe('{ not json')
  })
})

describe('avgTokPerSec', () => {
  test('is the session average over measured decode time', () => {
    expect(avgTokPerSec(5120, 10_000)).toBe(512)
    expect(avgTokPerSec(370, 1000)).toBe(370)
  })

  test('is null before any decode time has been measured', () => {
    expect(avgTokPerSec(5120, 0)).toBeNull()
  })
})

describe('ttftMs', () => {
  test('measures from the dispatched request to the first streamed token', () => {
    expect(ttftMs(1000, 1482)).toBe(482)
  })

  test('is null, not a fabricated 0, when an anchor is missing', () => {
    expect(ttftMs(null, 1482)).toBeNull()
    expect(ttftMs(1000, null)).toBeNull()
  })

  test('is null when the anchors invert, because formatLatency would clamp that to a fake 0ms', () => {
    // The reading the user saw as `TTFT 0ms`: a first token that appeared to precede its request.
    expect(ttftMs(1482, 1000)).toBeNull()
    expect(ttftMs(1482, 1482)).toBeNull()
  })
})

describe('ttftDisplay', () => {
  test('counts up while the request is in flight, marked as unfinished', () => {
    expect(ttftDisplay(1000, null, 1000)).toEqual({ text: '~0ms', live: true })
    expect(ttftDisplay(1000, null, 1000 + 482)).toEqual({ text: '~482ms', live: true })
    expect(ttftDisplay(1000, null, 1000 + 29_000)).toEqual({ text: '~29s', live: true })
  })

  test('freezes into the exact value the moment the first token lands', () => {
    expect(ttftDisplay(1000, 1482, 5000)).toEqual({ text: '482ms', live: false })
    // `now` keeps moving; a landed first token no longer ticks.
    expect(ttftDisplay(1000, 1482, 90_000)).toEqual({ text: '482ms', live: false })
  })

  test('shows nothing without a request in flight', () => {
    expect(ttftDisplay(null, null, 5000)).toBeNull()
    expect(ttftDisplay(null, 1482, 5000)).toBeNull()
  })

  test('shows nothing when the anchors invert, rather than a clamped fake', () => {
    expect(ttftDisplay(1482, 1000, 5000)).toBeNull()
  })
})

describe('bar', () => {
  test('fills proportionally with a 1/8-cell leading edge', () => {
    // 10 of 20 cells: no partial cell needed.
    expect(bar(plain, 20, 0.5)).toBe(`${cells('█', 10)}${cells('░', 10)}`)
    // 10.4 of 20 cells: the edge glyph carries the fraction.
    expect(bar(plain, 20, 0.52)).toBe(`${cells('█', 10)}▍${cells('░', 9)}`)
  })

  test('handles the empty and full ends, and clamps out-of-range input', () => {
    expect(bar(plain, 10, 0)).toBe('░'.repeat(10))
    expect(bar(plain, 10, 1)).toBe('█'.repeat(10))
    expect(bar(plain, 10, -1)).toBe('░'.repeat(10))
    expect(bar(plain, 10, 5)).toBe('█'.repeat(10))
  })

  test('always renders exactly `cells` columns so the row layout stays predictable', () => {
    for (const fraction of [0, 0.01, 0.33, 0.5, 0.99, 1]) {
      expect(bar(plain, 20, fraction)).toHaveLength(20)
    }
  })

  test('carries the pressure colour, not the value', () => {
    expect(bar(marked, 10, 0.4)).toContain('<accent>')
    expect(bar(marked, 10, 0.8)).toContain('<warning>')
    expect(bar(marked, 10, 0.95)).toContain('<error>')
  })
})

describe('pressure thresholds', () => {
  test('warn above 70% and error above 90%, matching the shipped footer', () => {
    expect(barColor(0.7)).toBe('accent')
    expect(barColor(0.71)).toBe('warning')
    expect(barColor(0.9)).toBe('warning')
    expect(barColor(0.91)).toBe('error')
  })

  test('the printed percentage uses the same boundaries', () => {
    expect(percentColor(null)).toBe('text')
    expect(percentColor(70)).toBe('text')
    expect(percentColor(70.1)).toBe('warning')
    expect(percentColor(90)).toBe('warning')
    expect(percentColor(90.1)).toBe('error')
  })
})

describe('row', () => {
  test('right-aligns the right group to the terminal width', () => {
    expect(row(plain, 20, 'left', 'right')).toBe(`left${cells(' ', 11)}right`)
  })

  test('drops the right group rather than rendering half of a number', () => {
    // 8 + 2 + 8 = 18 > 15, so the right group goes and the left is kept intact.
    expect(row(plain, 15, '12345678', '87654321')).toBe('12345678')
  })

  test('keeps the right group on its own line when only it fits', () => {
    expect(row(plain, 10, '', 'ABCDEFGHIJ')).toBe('ABCDEFGHIJ')
  })

  test('truncates only when a single group cannot fit at all', () => {
    const truncated = row(plain, 5, '1234567890', '')
    // Visible width, not string length: the returned line carries ANSI resets, and
    // the property that matters for a footer is that it never exceeds the terminal.
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(5)
    expect(truncated).toContain('…')
  })
})

describe('contextRow', () => {
  const parts = {
    percent: 17.5,
    tokens: 175000,
    window: 1000000,
    input: 194000,
    output: 89000,
    cacheHitRate: 99.8,
    cost: 1.612,
    todayCost: 4.36,
  }

  test('shows context pressure, the session volumes, the hit rate and the bill', () => {
    const line = contextRow(plain, 200, parts)
    expect(line).toContain('Context')
    expect(line).toContain('18%')
    expect(line).toContain('175k / 1.0M')
    expect(line).toContain('Input 194k')
    expect(line).toContain('Output 89k')
    expect(line).toContain('Cache hit 99.8%')
    expect(line).toContain('Cost $1.612')
    expect(line).toContain('Today $4.36')
  })

  test('renders the bill in the configured currency', () => {
    expect(contextRow(plain, 200, parts, { symbol: '¥', perUsd: 7.12 })).toContain('Cost ¥11.477')
  })

  test('never exceeds the terminal width, at any width', () => {
    for (const width of [40, 60, 70, 80, 95, 110, 120, 150, 200]) {
      expect(visibleWidth(contextRow(plain, width, parts))).toBeLessThanOrEqual(width)
    }
  })

  test('gives up the tokens/window detail first', () => {
    // Measured: the full row needs about 111 columns. Below that the detail goes and the
    // volumes stay, so a narrower terminal does not lose the figures this row exists for.
    const line = contextRow(plain, 115, parts)
    expect(line).not.toContain('175k / 1.0M')
    expect(line).toContain('Input 194k')
    expect(line).toContain('Output 89k')
    expect(line).toContain('Cost $1.612')
  })

  test('drops the volumes before it drops the bill', () => {
    const line = contextRow(plain, 90, parts)
    expect(line).not.toContain('Input')
    expect(line).not.toContain('Output')
    expect(line).toContain('Cache hit 99.8%')
    expect(line).toContain('Cost $1.612')
  })

  test('keeps the meter alone when nothing else fits', () => {
    const line = contextRow(plain, 60, parts)
    expect(line).toContain('Context')
    expect(line).toContain('18%')
    expect(line).not.toContain('Cost')
    expect(line).not.toContain('Cache hit')
  })

  test('reports an unknown window instead of inventing one', () => {
    const line = contextRow(plain, 200, { ...parts, percent: null, window: 0 })
    expect(line).toContain('?')
    expect(line).not.toContain('175k /')
    // The totals do not depend on the context reading, so they still render.
    expect(line).toContain('Cost $1.612')
  })

  test('omits a group it has no numbers for', () => {
    const line = contextRow(plain, 200, {
      percent: 0,
      tokens: 0,
      window: 1000000,
      input: 0,
      output: 0,
      cacheHitRate: null,
      cost: 0,
      todayCost: 0,
    })
    expect(line).toContain('Context')
    expect(line).not.toContain('Input')
    expect(line).not.toContain('Cache hit')
    expect(line).not.toContain('Cost')
  })
})

describe('shortenPath', () => {
  test('keeps the tail that identifies the project', () => {
    const path = '~/Workspaces/github/reedchan7/useful-pi-extensions'
    expect(shortenPath(path, 60)).toBe(path)
    expect(shortenPath(path, 40)).toBe('…/useful-pi-extensions')
    expect(shortenPath(path, 20)).toBe('useful-pi-extensions')
  })

  test('never returns a mid-word fragment', () => {
    // The regression this guards: slicing the tail produced "aster)".
    const shortened = shortenPath('~/Workspaces/github/deepseek-ai/deepseek-harness (master)', 12)
    expect(shortened).not.toContain('aster)')
    expect(shortened).toBe('deepseek-ha…')
  })
})

describe('isQuietStatus', () => {
  test('hides the pi-lens idle state', () => {
    expect(isQuietStatus('pi-lens-lsp', 'LSP Inactive')).toBe(true)
  })

  test('tolerates ANSI colouring and case, because pi-lens colours the text', () => {
    expect(isQuietStatus('pi-lens-lsp', '\u001b[38;2;168;187;193mLSP Inactive\u001b[39m')).toBe(
      true,
    )
    expect(isQuietStatus('pi-lens-lsp', 'lsp inactive')).toBe(true)
  })

  test('keeps the informative state', () => {
    expect(isQuietStatus('pi-lens-lsp', 'LSP Active: typescript')).toBe(false)
  })

  test('is scoped to the key, so another extension using the same words is untouched', () => {
    expect(isQuietStatus('other-extension', 'LSP Inactive')).toBe(false)
    expect(isQuietStatus('mcp', '🔌 MCP: 2 servers enabled')).toBe(false)
  })
})
