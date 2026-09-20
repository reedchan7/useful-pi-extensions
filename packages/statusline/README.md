# statusline

English | [中文](README_CN.md)

[npm](https://www.npmjs.com/package/@reedchan/statusline) · [pi packages gallery](https://pi.dev/packages/@reedchan/statusline) · [repository](https://github.com/reedchan7/useful-pi-extensions)

Replaces pi's footer with a labelled two-row one. Every value carries a word, so nothing has to
be decoded from a symbol or remembered from a legend. `ctrl+e` opens an optional context-breakdown
panel (next section) when you want to see what is occupying the window.

```text
Context window  █████████▍░░░░░░░░░░  47%   471k / 1.0M     Input 194k  ·  Output 89k  |  Cache hit 99.9%  |  Cost $0.23  ·  Today $1.63
~/.pi (master)                         deepseek-flash · Effort high | TTFT 482ms · Avg TTFT 612ms | Last 729 tok/s · Avg 512 tok/s
LSP Active: typescript
```

A narrower terminal gives the top row up in a fixed order rather than all at once: the `471k / 1.0M`
detail goes first, then the input/output volumes, leaving the hit rate and the bill. Below about 60
columns only the meter is left. Every step is a whole value — a number is never shown cut in half.

## What each part is

| Part                             | Meaning                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Context window` + meter + `47%` | Share of the model's context window in use. The fill turns `warning` above 70% and `error` above 90%, the same thresholds pi's shipped footer uses, and the percentage changes color with it |
| `471k / 1.0M`                    | Absolute context tokens over the window size. The first thing dropped when the terminal is narrow                                                                                            |
| Breakdown panel                  | What occupies the window — opt-in via `ctrl+e` or `/breakdown` — one bucket per line under a total. See [Context breakdown](#context-breakdown)                                              |
| `Input` / `Output`               | Session prompt and completion tokens. `Input` counts the prompt tokens that were neither read from nor written to cache, because pi reports those two separately in the same `usage` object  |
| `Cache hit`                      | The latest turn's cache hit rate, `cacheRead / (input + cacheRead + cacheWrite)`                                                                                                             |
| `Cost`                           | Session cost, in USD unless a config file names another currency (see below)                                                                                                                 |
| `Today`                          | Today's running cost across every project, session and model on this machine                                                                                                                 |
| Effort                           | The active thinking level                                                                                                                                                                    |
| `TTFT`                           | Time from request dispatch to the first streamed token                                                                                                                                       |
| `tok/s`                          | Decode throughput, i.e. output tokens per second of decode time                                                                                                                              |
| Last line                        | Other extensions' `ctx.ui.setStatus()` entries, so they do not silently disappear                                                                                                            |

## The meter

The meter is a **fixed 20 cells** and never stretches to the terminal. That is the one structural rule
taken from [cli-progress](https://www.npmjs.com/package/cli-progress)'s `shades_classic` preset
(≈10M downloads/week): its bar has a fixed `barsize` and is never widened to fill the row. An earlier
revision here did stretch it, which made the meter read as chrome rather than as an instrument.

The glyphs are that preset's block fill and shaded block track, with a 1/8-cell leading edge
(`▏▎▍▌▋▊▉`) so the fill grows smoothly instead of jumping a whole cell at a time.

## Context breakdown

`ctrl+e` or `/breakdown` opens an opt-in panel that answers the question the meter raises: what
is actually occupying the window. The concise footer stays the default; the choice is remembered
in `~/.pi/agent/statusline/config.json` (`"detail": true`).

```text
  Used                   360k   36.0%  ███░░░░░░░
  ─────────────────────────────────────────────
  Messages               289k   28.9%  ██░░░░░░░░
  Memory files ×2        1.5k    0.1%  ░░░░░░░░░░
  System tools ×22        686    0.1%  ░░░░░░░░░░
  Ext tools ×23           13k    1.3%  ░░░░░░░░░░
  Skills ×164             20k    2.0%  ░░░░░░░░░░
  System prompt          1.7k    0.2%  ░░░░░░░░░░
  Unaccounted             34k    3.4%  ░░░░░░░░░░
  ─────────────────────────────────────────────
  Autocompact buffer      16k    1.6%  ░░░░░░░░░░
  Free space             624k   62.4%  ██████░░░░
```

The title is row 1's and appears nowhere else. Three kinds of number, each behind a dim rule:
`Used`, the provider-reported total; the estimated buckets, ending with `Unaccounted` so the books
close (buckets are chars/4 estimates and Used is real — the gap is shown, not hidden, so the
column adds up both ways: buckets + Unaccounted = Used, Used + Autocompact buffer + Free space =
the window); and what is kept back or still open — which is also what says Free space is the
remainder, not a consumer. `×N` on a label is that bucket's count of files, tools or skills;
every value is tokens; every percentage is a share of the window; and every row ends in the same
share bar — the row-1 meter's own `█`/`░` glyphs at half size, one fill color, no new visual
device. Names and order are Claude Code's panel, with one exception:

| Row                  | What it counts                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Used`               | The provider-reported context total — the real number the estimates below are measured against                                                                                 |
| `Messages`           | The conversation on the active branch, including tool results, custom messages and compaction summaries                                                                        |
| `Memory files`       | Context files (AGENTS.md, CLAUDE.md and friends) rendered into the prompt, with their count                                                                                    |
| `System tools`       | JSON schemas of the built-in tools actually sent to the provider                                                                                                               |
| `Ext tools`          | JSON schemas of the tools registered by extensions, the SDK and MCP, with their count — the one bucket CC has no name for, since pi draws tools from extensions as well as MCP |
| `Skills`             | The prompt's skills section, with the number of skills listed                                                                                                                  |
| `System prompt`      | The rest of the system prompt: identity, tool list, rules, docs, cwd, extension sections                                                                                       |
| `Unaccounted`        | Used minus the estimate sum — the honest remainder of estimating, in dim; the reason the percentage column adds up                                                             |
| `Autocompact buffer` | Tokens compaction holds back for the model's reply — `compaction.reserveTokens` from settings; hidden when compaction is off                                                   |
| `Free space`         | Window minus usage minus reserve. Carries the meter's 70/90 pressure color, so it warns as the window fills                                                                    |

Every bucket except `Used` is an **estimate**, by pi's own chars/4 heuristic (`estimateTokens` in
`core/compaction`), which is exactly why `Unaccounted` exists: the estimates miss the real total,
and the panel shows the miss instead of letting the column not add up. The prompt shares are cut
from the exact prompt text the turn sends (captured at `before_agent_start`), and tool schemas
are measured from what `pi.getAllTools()` reports for the active set, so those two are close to
exact.

What Claude Code's panel shows that this panel deliberately does not: **custom agents** (pi has no
subagent concept) and **usage limits** (provider-specific subscription accounting; pi is
multi-provider). **Deferred tools** have no pi equivalent either — every active tool's schema is
always on the wire.

The panel is ~50 columns wide and fits any terminal by truncating rather than by dropping
buckets. The toggle lives on `ctrl+e` because `ctrl+j` is a bare LF in legacy terminals and reads
as Enter; if another extension owns `ctrl+e` on your machine, the key is `BREAKDOWN_SHORTCUT` at
the top of `index.ts`.

Configuration lives at the top of [`render.ts`](render.ts):

| Constant       | Default | Notes                                                                             |
| -------------- | ------- | --------------------------------------------------------------------------------- |
| `BAR_CELLS`    | `20`    | Meter width. Narrower for a quieter footer, wider for more resolution             |
| `BAR_FILL`     | `█`     | Fill glyph                                                                        |
| `BAR_TRACK`    | `░`     | Set to `""` for a trackless meter, or `"─"` for a hairline one                    |
| `QUIET_STATUS` | pi-lens | `[statusKey, pattern]` pairs whose matching text is hidden as "nothing to report" |

## Currency

pi prices every model in USD and its `cost` field carries no unit at all, so the footer cannot know
what you were actually billed. The currency and the rate live in `~/.pi/agent/statusline/config.json` — everything this
extension keeps (config plus the per-session state files that survive /reload) sits in that one folder:

```json
{
  "currency": {
    "code": "CNY"
  }
}
```

Two ways to set the rate:

- **Follow the market.** A `code` with no rate fetches the day's table from open.er-api.com on the
  first session of each day and caches the whole table in the file (`rates` + `fetchedAt`), so the
  next session starts warm and switching codes is instant and offline.
- **Pin it.** Add `"perUsd": 7.12` and the footer always uses that rate, never touching the network
  — the right choice when your platform bills in RMB directly, because a domestic price list is not
  the dollar list times a market rate.

`code` picks the symbol: `¥` for `CNY` and `RMB`, `JP¥` for `JPY` so the two never trade places, and
the table also knows `USD`, `EUR`, `GBP`, `HKD`, `TWD`, `SGD`, `KRW`, `INR`, `AUD`, `CAD`, `NZD` and
`CHF`; an unknown code is printed as it is. `symbol` overrides all of that.

Switching is editing `code`, or `make currency CODE=JPY` from a checkout. The file is read once per
session, so finish with `/reload`. A file that is there but unusable says so in a notification,
rather than silently showing dollars with nothing to explain why.

## Metrics

Throughput and latency follow the
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) turn-metrics contract
(`packages/client/ui-chat/src/client/contract/turn-metrics.ts`), including its number formatting:

```text
ttftMs   = firstTokenTime - stepStartTime
decodeMs = completedTime  - firstTokenTime
tok/s    = usage.output / (decodeMs / 1000)
```

So the rate excludes prefill and time-to-first-token, which is the industry-standard
"output tokens per second" figure.

- **Final values are exact.** They use the provider's reported `usage.output` over the measured
  decode window.
- **Live values are estimates**, marked with `~`. Providers report usage only on the final stream
  chunk, so the streaming token count is inferred from streamed characters scaled by a
  tokens-per-character ratio learned from this session's own reported usage.
- **TTFT is exact as soon as the first token arrives** and never changes for that turn.
- The reading appears after the first turn completes in the session, because it can only come from
  streamed events.

## Requirements and limits

- One extension owns the footer. `ctx.ui.setFooter()` is exclusive, so installing another footer
  extension alongside this one is a race, not a merge. This extension stands down if
  [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) announces itself, so the two coexist
  without fighting.
- The footer renders on `ctx.getContextUsage()`, `ctx.getSystemPrompt()`, `ctx.sessionManager`,
  `pi.getAllTools()` and `pi.getActiveTools()`, all public API; nothing reaches into pi's
  internals.
- Provider status such as `MCP: 2 servers enabled` is informational and can be turned off at its
  source: `settings.mcpFooterStatus` in `~/.pi/agent/mcp.json`. `LSP Inactive` from pi-lens has no
  such setting, so it is filtered here as a "quiet" status.

## Install

```sh
# on its own
pi install npm:@reedchan/statusline

# or as part of the collection, which installs every extension in the repository
pi install npm:useful-pi-extensions
```

Then `/reload`.
