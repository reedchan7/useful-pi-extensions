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
  formatCost,
  formatLatency,
  formatTokens,
  formatTps,
  isQuietStatus,
  percentColor,
  row,
  shortenPath,
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
  test('trims the padding zero that toFixed(3) adds', () => {
    expect(formatCost(0.38)).toBe('$0.38')
    expect(formatCost(0.003)).toBe('$0.003')
    expect(formatCost(1.25)).toBe('$1.25')
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
