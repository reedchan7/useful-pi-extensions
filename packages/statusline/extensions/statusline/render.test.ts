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
  breakdownPanel,
  contextRow,
  currencyFromConfig,
  detailFromConfig,
  entryChars,
  formatCost,
  formatLatency,
  formatTokens,
  formatTps,
  frozenThroughput,
  isQuietStatus,
  messagesTokens,
  parseCurrency,
  percentColor,
  promptBreakdown,
  row,
  shortenPath,
  splitToolTokens,
  timingRow,
  avgTokPerSec,
  cachedRates,
  ratesFromPayload,
  cacheIsFresh,
  withCachedRates,
  toolTokens,
  ttftDisplay,
  ttftMs,
  withDetailFlag,
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
    expect(formatLatency(1000)).toBe('1.0s')
    expect(formatLatency(2000)).toBe('2.0s')
    expect(formatLatency(4820)).toBe('4.8s')
    expect(formatLatency(42000)).toBe('42s')
  })
})

describe('formatCost', () => {
  test('rounds to two decimals and trims the padding zeros, all of them', () => {
    expect(formatCost(0.38)).toBe('$0.38')
    expect(formatCost(0.003)).toBe('<$0.01')
    expect(formatCost(0.0005, { symbol: '¥', perUsd: 7.12 })).toBe('<¥0.01')
    expect(formatCost(0.006)).toBe('$0.01')
    expect(formatCost(1.25)).toBe('$1.25')
    expect(formatCost(1.5)).toBe('$1.5')
    expect(formatCost(10)).toBe('$10')
  })

  test('converts at the configured rate, because pi only ever prices in USD', () => {
    const cny = { symbol: '¥', perUsd: 7.12 }
    expect(formatCost(1.612, cny)).toBe('¥11.48')
    expect(formatCost(0.38, cny)).toBe('¥2.71')
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

describe('frozenThroughput', () => {
  test('is the whole-message rate over a real decode window', () => {
    expect(frozenThroughput(1000, 82, 200)).toBe(82)
  })

  test('is null, not output-per-millisecond fiction, for a burst arrival', () => {
    // A short greeting delivered in one burst measured a 1ms decode window and once froze the
    // footer at `Last 82000 tok/s`. There was no decode phase; there is no rate.
    expect(frozenThroughput(1, 82, 200)).toBeNull()
    expect(frozenThroughput(199, 82, 200)).toBeNull()
  })

  test('the sample floor itself counts as a decode phase', () => {
    expect(frozenThroughput(200, 100, 200)).toBe(500)
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
    expect(line).toContain('Cost $1.61')
    expect(line).toContain('Today $4.36')
  })

  test('renders the bill in the configured currency', () => {
    expect(contextRow(plain, 200, parts, { symbol: '¥', perUsd: 7.12 })).toContain('Cost ¥11.48')
  })

  test('never exceeds the terminal width, at any width', () => {
    for (const width of [24, 30, 40, 60, 70, 80, 95, 110, 120, 150, 200]) {
      expect(visibleWidth(contextRow(plain, width, parts))).toBeLessThanOrEqual(width)
    }
  })

  test('gives up the tokens/window detail first', () => {
    // Measured: the full row needs about 119 columns. Below that the detail goes and the
    // volumes stay, so a narrower terminal does not lose the figures this row exists for.
    const line = contextRow(plain, 120, parts)
    expect(line).not.toContain('175k / 1.0M')
    expect(line).toContain('Input 194k')
    expect(line).toContain('Output 89k')
    expect(line).toContain('Cost $1.61')
  })

  test('drops the volumes before it drops the bill', () => {
    const line = contextRow(plain, 90, parts)
    expect(line).not.toContain('Input')
    expect(line).not.toContain('Output')
    expect(line).toContain('Cache hit 99.8%')
    expect(line).toContain('Cost $1.61')
  })

  test('keeps the bills through the width where the volumes just fell off', () => {
    // The old ladder stopped here: below ~87 columns the whole right group vanished and the
    // footer showed nothing but the meter. The cache rate goes now; the money stays.
    const line = contextRow(plain, 80, parts)
    expect(line).toContain('Cost $1.61')
    expect(line).toContain('Today $4.36')
    expect(line).not.toContain('Cache hit')
  })

  test('shrinks the bar before it drops the bill', () => {
    const line = contextRow(plain, 60, parts)
    expect(line).toContain('18%')
    expect(line).toContain('Cost $1.61')
    expect(line).toContain('Today $4.36')
    expect(line).not.toContain('Cache hit')
    expect(line).not.toContain('Input')
  })

  test("today's total goes before the session's own bill", () => {
    const line = contextRow(plain, 50, parts)
    expect(line).toContain('Cost $1.61')
    expect(line).not.toContain('Today $4.36')
    expect(line).not.toContain('Cache hit')
  })

  test('the bar gives up cells before the percent is ever lost', () => {
    const line = contextRow(plain, 26, parts)
    expect(line).toContain('18%')
    expect(line).not.toContain('Cost')
    expect(visibleWidth(line)).toBeLessThanOrEqual(26)
  })

  test('past the bar, the label goes — never the number', () => {
    const line = contextRow(plain, 16, parts)
    expect(line).toContain('18%')
    expect(line).not.toContain('Context window')
    expect(visibleWidth(line)).toBeLessThanOrEqual(16)
  })

  test('reports an unknown window instead of inventing one', () => {
    const line = contextRow(plain, 200, { ...parts, percent: null, window: 0 })
    // pi reports null percent for models without a context window: an em dash, not a question.
    expect(line).toContain('--')
    expect(line).not.toContain('175k /')
    // The totals do not depend on the context reading, so they still render.
    expect(line).toContain('Cost $1.61')
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

describe('timingRow', () => {
  // 96 cells wide when every slot shows: 29 identity + 5 wall + 27 timing + 5 wall + 30 throughput.
  const full = {
    model: 'glm-5.3-flash',
    effort: 'high',
    ttft: '1.1s',
    avgTtft: '0.9s',
    last: '82 tok/s',
    avg: '61 tok/s',
  }

  test('wide enough: identity, timing and throughput groups behind walls', () => {
    expect(timingRow(plain, 120, full)).toBe(
      'glm-5.3-flash  ·  Effort high  |  TTFT 1.1s  ·  Avg TTFT 0.9s  |  Last 82 tok/s  ·  Avg 61 tok/s',
    )
  })

  test('the aggregates give up their seats first, whole slots never halves', () => {
    // 90 cells fits the line minus the throughput average; the screenshot's `Avg T…` mid-label
    // cut is what the ladder exists to prevent.
    expect(timingRow(plain, 90, full)).toBe(
      'glm-5.3-flash  ·  Effort high  |  TTFT 1.1s  ·  Avg TTFT 0.9s  |  Last 82 tok/s',
    )
  })

  test('then the effort level, static config before measured history', () => {
    expect(timingRow(plain, 60, full)).toBe('glm-5.3-flash  |  TTFT 1.1s  |  Last 82 tok/s')
  })

  test('the model and the TTFT clock are the floor', () => {
    expect(timingRow(plain, 30, full)).toBe('glm-5.3-flash  |  TTFT 1.1s')
  })

  test('past the floor the line truncates whole — a model id has no drop-in substitute', () => {
    const line = timingRow(plain, 20, full)
    expect(visibleWidth(line)).toBeLessThanOrEqual(20)
    // The model floor survives intact; the ellipsis marks what a wider window would show.
    expect(line.startsWith('glm-5.3-flash')).toBe(true)
    expect(line).toContain('…')
  })

  test('null slots vanish with their walls', () => {
    expect(
      timingRow(plain, 50, {
        model: 'glm-5.3-flash',
        effort: null,
        ttft: null,
        avgTtft: null,
        last: null,
        avg: null,
      }),
    ).toBe('glm-5.3-flash')
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

  test('quiets every LSP health line — active and failed are noise once diagnostics work', () => {
    expect(isQuietStatus('pi-lens-lsp', 'LSP Active: json, ast-grep, typos')).toBe(true)
    expect(isQuietStatus('pi-lens-lsp', 'LSP Failed: opengrep')).toBe(true)
  })

  test('is scoped to the key, so another extension using the same words is untouched', () => {
    expect(isQuietStatus('other-extension', 'LSP Inactive')).toBe(false)
    expect(isQuietStatus('mcp', '🔌 MCP: 2 servers enabled')).toBe(false)
  })
})

describe('entryChars and messagesTokens', () => {
  test('counts message entries the way the model receives them', () => {
    // 400 chars of text = 100 tokens by pi's chars/4 rule.
    const text = 'x'.repeat(400)
    expect(
      entryChars({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }),
    ).toBe(400)
    expect(
      entryChars({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
      }),
    ).toBe(400)
    expect(
      entryChars({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: { path: 'x'.repeat(200) } }],
        },
      }),
    ).toBeGreaterThan(200)
  })

  test('counts an image at the estimate pi itself uses, not at zero', () => {
    expect(
      entryChars({ type: 'message', message: { role: 'user', content: [{ type: 'image' }] } }),
    ).toBe(4800)
  })

  test('counts compaction and branch summaries, because they are replayed into context', () => {
    expect(entryChars({ type: 'compaction', summary: 'x'.repeat(400) })).toBe(400)
    expect(entryChars({ type: 'branch_summary', summary: 'x'.repeat(400) })).toBe(400)
    expect(entryChars({ type: 'custom_message', content: 'x'.repeat(400) })).toBe(400)
  })

  test('counts a system message as zero, because the prompt bucket already owns it', () => {
    // Counting both would double the prompt — the regression this guard exists for.
    expect(
      entryChars({ type: 'message', message: { role: 'system', content: 'x'.repeat(400) } }),
    ).toBe(0)
  })

  test('treats unrecognizable entries as empty, so a hand-edited session degrades, not crashes', () => {
    expect(entryChars(null)).toBe(0)
    expect(entryChars(42)).toBe(0)
    expect(entryChars({ type: 'label' })).toBe(0)
    expect(entryChars({ type: 'message' })).toBe(0)
    expect(
      messagesTokens([{ type: 'message', message: { role: 'user', content: 'abcd' } }, null]),
    ).toBe(1)
  })
})

describe('promptBreakdown', () => {
  // A miniature of pi's real rendering: sections wrapped as `<tag>\n...\n</tag>`.
  const prompt = [
    'You are an expert coding assistant.',
    '<rules>',
    '- Be concise',
    '</rules>',
    '<project_context>',
    'Project-specific instructions and guidelines:',
    '<project_instructions path="/x/AGENTS.md">',
    'a'.repeat(400),
    '</project_instructions>',
    '<project_instructions path="/y/AGENTS.md">',
    'b'.repeat(200),
    '</project_instructions>',
    '</project_context>',
    '<skills>',
    '<available_skills>',
    '  <skill>',
    '    <name>seo</name>',
    '    <description>Optimize for search</description>',
    '  </skill>',
    '  <skill>',
    '    <name>tdd</name>',
    '    <description>Test first</description>',
    '  </skill>',
    '</available_skills>',
    '</skills>',
    '<cwd>',
    '/tmp',
    '</cwd>',
  ].join('\n')

  test('splits the prompt into files, skills and the rest, in tokens', () => {
    const parts = promptBreakdown(prompt)
    // 600 chars of file content + wrappers and headers, /4: the exact wrapper overhead is
    // irrelevant, the bucket must simply carry the bulk of those bytes.
    expect(parts.files).toBeGreaterThan(150)
    expect(parts.fileCount).toBe(2)
    expect(parts.skills).toBeGreaterThan(20)
    expect(parts.skillCount).toBe(2)
    expect(parts.prompt).toBeGreaterThan(0)
    // The remainder must not still contain the extracted sections.
    expect(parts.prompt).toBeLessThan(600 / 4 + 20)
  })

  test('a prompt without those sections reports zero, not a crash', () => {
    const parts = promptBreakdown('just a preamble')
    expect(parts.files).toBe(0)
    expect(parts.fileCount).toBe(0)
    expect(parts.skills).toBe(0)
    expect(parts.skillCount).toBe(0)
    expect(parts.prompt).toBe(tokensFromCharsForTest('just a preamble'))
  })
})

/** The same chars/4 rule the production code applies, spelled out for expectations. */
function tokensFromCharsForTest(text: string): number {
  return Math.ceil(text.length / 4)
}

/** The percentage a panel row carries, as a number — NaN when the row has none. */
function pctOfRow(line: string | undefined): number {
  return Number((line?.match(/(\d+\.\d)%/) ?? [])[1] ?? Number.NaN)
}

describe('toolTokens and splitToolTokens', () => {
  const builtin = { name: 'read', description: 'd'.repeat(100), sourceInfo: { source: 'builtin' } }
  const mcp = {
    name: 'lark_im',
    description: 'm'.repeat(100),
    parameters: { type: 'object' },
    sourceInfo: { source: 'npm:@reedchan/lark' },
  }

  test('costs a tool by its name, description and schema', () => {
    // No parameters stringifies as "{}": two characters, still on the wire.
    expect(toolTokens(builtin)).toBe(Math.ceil((4 + 100 + 48 + 2) / 4))
    expect(toolTokens({ ...mcp, parameters: { x: 'y'.repeat(40) } })).toBeGreaterThan(
      toolTokens({ ...mcp, parameters: {} }),
    )
  })

  test('inactive tools cost nothing, because the provider never sees them', () => {
    const split = splitToolTokens([builtin, mcp], ['read'])
    expect(split.builtin).toBe(toolTokens(builtin))
    expect(split.builtinCount).toBe(1)
    expect(split.other).toBe(0)
    expect(split.otherCount).toBe(0)
  })

  test('non-builtin sources — extension, SDK, MCP — land in the Ext bucket together', () => {
    const split = splitToolTokens([builtin, mcp], ['read', 'lark_im'])
    expect(split.other).toBe(toolTokens(mcp))
    expect(split.otherCount).toBe(1)
  })
})

describe('breakdownPanel', () => {
  const parts = {
    messages: 214_000,
    promptParts: { files: 23_000, fileCount: 14, skills: 10_000, skillCount: 95, prompt: 6_500 },
    toolSplit: { builtin: 22_000, builtinCount: 22, other: 4_400, otherCount: 12 },
    reserve: 16_384,
    free: 683_616,
    usedPercent: 30,
    window: 1_000_000,
    used: 300_000,
  }

  test('the real total leads; rules separate the kinds, no title of its own', () => {
    const lines = breakdownPanel(marked, 300, parts)
    // Row 1 owns the title; repeating it here was a duplicate that could not align with the grid.
    for (const line of lines) expect(line).not.toContain('Context window')
    // The Used row anchors the grid, its label brighter than the dim bucket labels.
    expect(lines[0]).toContain('<text>Used')
    expect(lines[0]).toContain('30.0%')
    // Rules between kinds — never around them.
    expect(lines[1]).toContain('──────────')
    expect(lines[9]).toContain('──────────')
  })

  test('one row per bucket, in the order of the Claude Code panel', () => {
    const lines = breakdownPanel(plain, 300, parts)
    expect(lines).toHaveLength(12)
    expect(lines[0]).toContain('Used')
    expect(lines[2]).toContain('Messages')
    // Counts ride on the label as ×N — never as bare parentheses.
    expect(lines[3]).toContain('Memory files ×14')
    expect(lines[4]).toContain('System tools ×22')
    expect(lines[5]).toContain('Ext tools ×12')
    expect(lines[6]).toContain('Skills ×95')
    expect(lines[7]).toContain('System prompt')
    expect(lines[8]).toContain('Unaccounted')
    expect(lines[10]).toContain('Autocompact buffer')
    expect(lines[11]).toContain('Free space')
  })

  test('the books close: buckets + Unaccounted = Used, and Used + buffer + Free = window', () => {
    const lines = breakdownPanel(plain, 300, parts)
    // The regression this guards: estimates missed the real total and the column did not add up.
    const buckets = [2, 3, 4, 5, 6, 7, 8].reduce((sum, index) => sum + pctOfRow(lines[index]), 0)
    expect(Math.abs(buckets - pctOfRow(lines[0]))).toBeLessThanOrEqual(0.5)
    const whole = pctOfRow(lines[0]) + pctOfRow(lines[10]) + pctOfRow(lines[11])
    expect(Math.abs(whole - 100)).toBeLessThanOrEqual(0.5)
    // Unaccounted is exactly the gap between the real total and the estimate sum.
    const estimated = 214_000 + 23_000 + 10_000 + 6_500 + 22_000 + 4_400
    expect(pctOfRow(lines[8])).toBeCloseTo(((300_000 - estimated) / 1_000_000) * 100, 1)
  })

  test('every bucket shows its share of the window, and a bar to compare by eye', () => {
    const lines = breakdownPanel(plain, 300, parts)
    expect(lines[2]).toContain('21.4%')
    expect(lines[11]).toContain('68.4%')
    // The bars are the row-1 meter's own glyphs — █ fill on ░ track, whole cells only: the
    // 1/8-cell edges read as stray vertical strokes, and the hairline track read as clutter.
    const rows = [0, 2, 3, 4, 5, 6, 7, 8, 10, 11]
    for (const index of rows) {
      expect(lines[index]?.slice(-10)).toMatch(/^[█░]{10}$/)
    }
    // One fill color for every row — no green-here-white-there.
    const bars = breakdownPanel(marked, 300, parts)
    for (const index of rows) {
      expect(bars[index]).toMatch(/<muted>█*<\/muted><dim>░*<\/dim>$/)
    }
    // Magnitudes compare: Free space's bar outfills Messages's.
    expect((lines[11]?.match(/█/g) ?? []).length).toBeGreaterThan(
      (lines[2]?.match(/█/g) ?? []).length,
    )
  })

  test('columns align: every line, rules included, renders the same visible width', () => {
    const lines = breakdownPanel(plain, 300, parts)
    const widths = new Set(lines.map((line) => visibleWidth(line)))
    expect(widths.size).toBe(1)
  })

  test('omits buckets it has nothing to say about', () => {
    const lines = breakdownPanel(plain, 300, {
      messages: 0,
      promptParts: null,
      toolSplit: null,
      reserve: null,
      free: null,
      usedPercent: null,
      window: 1_000_000,
      used: 0,
    })
    // Used, a rule, and Messages alone — no Unaccounted when there is no gap to explain.
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Used')
    expect(lines[2]).toContain('Messages')
    expect(lines[2]).toContain('0.0%')
  })

  test('keeps every row inside the terminal width, at any width', () => {
    // The panel is ~50 columns; even a phone-sized terminal keeps all of it by truncating.
    for (const width of [20, 30, 40, 50, 60, 120, 300]) {
      for (const line of breakdownPanel(plain, width, parts)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  test('colors Free space with the pressure thresholds of the meter', () => {
    const calm = breakdownPanel(marked, 300, { ...parts, usedPercent: 27 })
    expect(calm[11]).toContain('<text>')
    const tight = breakdownPanel(marked, 300, { ...parts, usedPercent: 95 })
    expect(tight[11]).toContain('<error>')
  })
})

describe('detailFromConfig and withDetailFlag', () => {
  test('the concise footer is the default, and only an explicit true opens the panel', () => {
    expect(detailFromConfig(null)).toBe(false)
    expect(detailFromConfig('{}')).toBe(false)
    expect(detailFromConfig('{ not json')).toBe(false)
    expect(detailFromConfig('{"detail":false}')).toBe(false)
    expect(detailFromConfig('{"currency":{"code":"CNY"}}')).toBe(false)
    expect(detailFromConfig('{"detail":true}')).toBe(true)
  })

  test('toggling writes the flag back without disturbing keys it does not own', () => {
    const updated = withDetailFlag('{"currency":{"code":"CNY"}}', true)
    expect(updated).toContain('"detail": true')
    expect(updated).toContain('"code": "CNY"')
    expect(detailFromConfig(updated)).toBe(true)
  })

  test('never returns a replacement for a file it could not parse', () => {
    expect(withDetailFlag('{ not json', false)).toBeNull()
    expect(withDetailFlag('"just a string"', false)).toBeNull()
  })
})
