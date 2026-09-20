# statusline

English | [中文](README_CN.md)

[npm](https://www.npmjs.com/package/@reedchan/statusline) · [pi packages gallery](https://pi.dev/packages/@reedchan/statusline) · [repository](https://github.com/reedchan7/useful-pi-extensions)

Replaces pi's footer with a labelled two-row one. Every value carries a word, so nothing has to be
decoded from a symbol or remembered from a legend.

```
Context  █████████▍░░░░░░░░░░  47%   471k / 1.0M     Input 194k  ·  Output 89k  |  Cache hit 99.9%  |  Cost $0.229  ·  Today $1.63
~/.pi (master)                         deepseek-flash · Effort high | TTFT 482ms · Avg TTFT 612ms | Last 729 tok/s · Avg 512 tok/s
LSP Active: typescript
```

A narrower terminal gives the row up in a fixed order rather than all at once: the `471k / 1.0M`
detail goes first, then the input/output volumes, leaving the hit rate and the bill. Below about 60
columns only the meter is left. Every step is a whole value — a number is never shown cut in half.

## What each part is

| Part                      | Meaning                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Context` + meter + `47%` | Share of the model's context window in use. The fill turns `warning` above 70% and `error` above 90%, the same thresholds pi's shipped footer uses, and the percentage changes color with it |
| `471k / 1.0M`             | Absolute context tokens over the window size. The first thing dropped when the terminal is narrow                                                                                            |
| `Input` / `Output`        | Session prompt and completion tokens. `Input` counts the prompt tokens that were neither read from nor written to cache, because pi reports those two separately in the same `usage` object  |
| `Cache hit`               | The latest turn's cache hit rate, `cacheRead / (input + cacheRead + cacheWrite)`                                                                                                             |
| `Cost`                    | Session cost, in USD unless a config file names another currency (see below)                                                                                                                 |
| `Today`                   | Today's running cost across every project, session and model on this machine                                                                                                                 |
| Effort                    | The active thinking level                                                                                                                                                                    |
| `TTFT`                    | Time from request dispatch to the first streamed token                                                                                                                                       |
| `tok/s`                   | Decode throughput, i.e. output tokens per second of decode time                                                                                                                              |
| Last line                 | Other extensions' `ctx.ui.setStatus()` entries, so they do not silently disappear                                                                                                            |

## The meter

The meter is a **fixed 20 cells** and never stretches to the terminal. That is the one structural rule
taken from [cli-progress](https://www.npmjs.com/package/cli-progress)'s `shades_classic` preset
(≈10M downloads/week): its bar has a fixed `barsize` and is never widened to fill the row. An earlier
revision here did stretch it, which made the meter read as chrome rather than as an instrument.

The glyphs are that preset's block fill and shaded block track, with a 1/8-cell leading edge
(`▏▎▍▌▋▊▉`) so the fill grows smoothly instead of jumping a whole cell at a time.

Configuration lives at the top of [`render.ts`](render.ts):

| Constant       | Default | Notes                                                                             |
| -------------- | ------- | --------------------------------------------------------------------------------- |
| `BAR_CELLS`    | `20`    | Meter width. Narrower for a quieter footer, wider for more resolution             |
| `BAR_FILL`     | `█`     | Fill glyph                                                                        |
| `BAR_TRACK`    | `░`     | Set to `""` for a trackless meter, or `"─"` for a hairline one                    |
| `QUIET_STATUS` | pi-lens | `[statusKey, pattern]` pairs whose matching text is hidden as "nothing to report" |

## Currency

pi prices every model in USD and its `cost` field carries no unit at all, so the footer cannot know
what you were actually billed. The currency and the rate live in `~/.pi/agent/statusline.json`:

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

## Metrics

Throughput and latency follow the
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) turn-metrics contract
(`packages/client/ui-chat/src/client/contract/turn-metrics.ts`), including its number formatting:

```
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
- The footer renders on `ctx.sessionManager.getEntries()` and `ctx.getContextUsage()`, both public
  API; nothing reaches into pi's internals.
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
