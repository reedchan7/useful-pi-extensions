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

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import {
  contextRow,
  currencyFromConfig,
  formatCwd,
  formatLatency,
  formatTps,
  isQuietStatus,
  pair,
  row,
  shortenPath,
  USD,
  type Currency,
} from './render.ts'

const LIVE_RENDER_MS = 200
const WINDOW_MS = 2000
const MIN_SAMPLE_MS = 200
/** Pi's own estimateTokens() heuristic, used only until a real ratio is known. */
const FALLBACK_TOKENS_PER_CHAR = 0.25

/** The status line's own settings file, alongside pi's other per-tool config. */
const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'statusline.json')

/**
 * Reads the display currency.
 *
 * Called once per session on purpose: a footer that stat'ed a file on every frame would be its own
 * bug. Editing the file therefore takes effect on `/reload`.
 */
async function loadCurrency(notify: (message: string) => void): Promise<Currency> {
  try {
    await stat(CONFIG_PATH)
  } catch {
    // No config file is the normal case, and it means USD.
    return USD
  }
  let text: string
  try {
    text = await readFile(CONFIG_PATH, 'utf8')
  } catch {
    notify('statusline.json exists but could not be read, showing USD')
    return USD
  }
  const { currency, problem } = currencyFromConfig(text)
  if (problem !== null) notify(problem)
  return currency
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
}

/** The usage fields this footer totals, read structurally so no cast is needed. */
type UsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: { total: number }
}

function collectTotals(ctx: ExtensionContext): Totals {
  const totals: Totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: null,
  }
  // `usage` stays optional here even though an assistant message always carries it:
  // a truncated or hand-edited session file is the case this guard is for.
  const add = (usage: UsageTotals | undefined, assistant: boolean): void => {
    if (!usage) return
    totals.input += usage.input
    totals.output += usage.output
    totals.cacheRead += usage.cacheRead
    totals.cacheWrite += usage.cacheWrite
    totals.cost += usage.cost.total
    if (!assistant) return
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    if (prompt > 0) totals.cacheHitRate = (usage.cacheRead / prompt) * 100
  }
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === 'message') {
      const { message } = entry
      if (message.role === 'assistant') add(message.usage, true)
      else if (message.role === 'toolResult') add(message.usage, false)
      continue
    }
    // Compaction and branch summaries bill a model call of their own.
    if (entry.type === 'compaction' || entry.type === 'branch_summary') add(entry.usage, false)
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

  let chars = 0
  let stepStartedAt = 0
  let firstTokenAt: number | null = null
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

  function publish(rate: number, exact: boolean, ttftMs: number | null): void {
    reading = { rate, exact, ttftMs }
    requestRender?.()
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
          const totals = collectTotals(ctx)
          const row1 = contextRow(
            theme,
            width,
            {
              percent: usage?.percent ?? null,
              tokens: usage?.tokens ?? 0,
              window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
              input: totals.input,
              output: totals.output,
              cacheHitRate: totals.cacheHitRate,
              cost: totals.cost,
            },
            currency,
          )

          // Row 2: model and the latest turn's timing on the right, path on the left.
          const model = ctx.model?.id ?? 'no model'
          const row2Parts = [theme.fg('accent', model)]
          if (ctx.thinkingLevel) row2Parts.push(pair(theme, 'Effort', ctx.thinkingLevel, 'muted'))
          if (reading) {
            if (reading.ttftMs !== null)
              row2Parts.push(pair(theme, 'TTFT', formatLatency(reading.ttftMs), 'muted'))
            row2Parts.push(
              theme.fg(
                reading.exact ? 'success' : 'dim',
                `${reading.exact ? '' : '~'}${formatTps(reading.rate)} tok/s`,
              ),
            )
          }
          const row2Right = row2Parts.join(theme.fg('dim', '  ·  '))

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

          const lines = [row1, row(theme, width, row2Left, row2Right)]

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

  pi.on('session_start', async (_event, ctx) => {
    ratio = seedRatio(ctx)
    reading = null
    resetStream()
    currency = await loadCurrency((message) => ctx.ui.notify(message, 'warning'))
    installFooter(ctx)
  })

  pi.on('message_start', async (event) => {
    if (event.message.role !== 'assistant') return
    resetStream()
    stepStartedAt = Date.now()
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
    if (firstTokenAt === null) firstTokenAt = now
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
    publish(rate, false, firstTokenAt - stepStartedAt)
  })

  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return

    const message = event.message as { content: unknown; usage?: { output?: number } }
    const output = message.usage?.output ?? 0
    const totalChars = blockChars(message.content)
    if (output > 0 && totalChars > 0) {
      const sample = output / totalChars
      ratio = ratio === null ? sample : (ratio + sample) / 2
    }

    const decodeMs = firstTokenAt !== null ? Date.now() - firstTokenAt : 0
    const ttftMs = firstTokenAt !== null ? firstTokenAt - stepStartedAt : null
    const tokens = output > 0 ? output : totalChars * (ratio ?? FALLBACK_TOKENS_PER_CHAR)
    if (ttftMs !== null && decodeMs >= MIN_SAMPLE_MS)
      publish((tokens / decodeMs) * 1000, output > 0, ttftMs)
    resetStream()
  })
}
