# statusline

[English](README.md) | 中文

[npm](https://www.npmjs.com/package/@reedchan/statusline) · [pi packages 画廊](https://pi.dev/packages/@reedchan/statusline) · [仓库](https://github.com/reedchan7/useful-pi-extensions)

替换 pi 的 footer，改成带文字标签的两行。每个值都带一个词，不需要靠符号猜、也不需要记图例。
需要看窗口里到底装了什么时，`ctrl+q` 可打开一个可选的上下文明细面板（见下文）。

```text
Context window  █████████▍░░░░░░░░░░  47%   471k / 1.0M     Input 194k  ·  Output 89k  |  Cache hit 99.9%  |  Cost $0.23  ·  Today $1.63
~/.pi (master)                         deepseek-flash · Effort high | TTFT 482ms · Avg TTFT 612ms | Last 729 tok/s · Avg 512 tok/s
LSP Active: typescript
```

终端变窄时，第一行是**按固定顺序**逐项舍弃的，而不是整体消失：先丢 `471k / 1.0M`，
再丢输入/输出量，最后保留命中率与花费。窄于约 60 列时就只剩仪表了。
每一步丢的都是完整的一项，绝不出现被截掉一半的数字。

## 每一项是什么

| 部分                              | 含义                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Context window` + 仪表 + `47.1%` | 已占模型上下文窗口的比例。填充超过 70% 转 `warning`、超过 90% 转 `error`（与 pi 原生 footer 同一套阈值），百分比同步变色                |
| `471k / 1.0M`                     | 上下文已用 token / 窗口大小。终端变窄时**第一个被舍弃**                                                                                 |
| Breakdown 面板                    | 窗口里到底装了什么，总数领队、每桶一行——可选，`ctrl+q` 或 `/breakdown` 打开。见[上下文明细](#上下文明细)                                |
| `Input` / `Output`                | 会话的输入与输出 token 量。`Input` 指既没命中缓存、也没写入缓存的那部分 prompt token，因为 pi 把这两种情况在同一个 `usage` 对象里分开报 |
| `Cache hit`                       | 最近一轮的缓存命中率，`cacheRead / (input + cacheRead + cacheWrite)`                                                                    |
| `Cost`                            | 会话花费，默认美元；配置了其他币种则换算显示（见下）                                                                                    |
| `Today`                           | 当天跨项目、跨会话、跨模型的累计花费                                                                                                    |
| Effort                            | 当前思考等级                                                                                                                            |
| `TTFT`                            | 从发出请求到第一个流式 token 的耗时                                                                                                     |
| `tok/s`                           | 解码吞吐，即每秒解码时间产出的输出 token 数                                                                                             |
| 最后一行                          | 其他扩展通过 `ctx.ui.setStatus()` 设的状态，否则它们会静默消失                                                                          |

## 关于这个仪表

仪表**固定 20 格，永不拉伸到终端宽度**。这是从 [cli-progress](https://www.npmjs.com/package/cli-progress)
的 `shades_classic` 预设（约 1000 万次/周下载）里抄来的唯一一条结构性规则：它的进度条有固定 `barsize`，
永远不会被撑满整行。之前的版本正是撑满了整行，于是它读起来像"装饰线"而不是"仪表"。

字形也来自那个预设（实心块填充 + 阴影块轨道），额外加了 1/8 格收尾（`▏▎▍▌▋▊▉`），
让填充平滑增长，而不是一次跳一整格。

## 上下文明细

`ctrl+q` 或 `/breakdown` 打开一个可选面板，回答仪表提出的问题：窗口里到底装了什么。
简洁两行是默认形态；开关状态记在 `~/.pi/agent/statusline/config.json`（`"detail": true`）。

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

标题是第一行的，面板里不再重复。三类数字，每类后面一条 dim 分割线：`Used`——provider 上报的
真实总量；估算桶——以 `Unaccounted` 收尾让账目闭合（桶是 chars/4 估算、Used 是真实值，差值亮出
来而不是藏掉，于是两个方向都加得平：桶 + Unaccounted = Used，Used + Autocompact buffer +
Free space = 窗口）；以及预留与余量——这也同时说清了 Free space 是余量而非占用者。标签上的
`×N` 是该桶的文件/工具/技能数；所有数值都是 token；百分比都是占窗口的比例；每行末尾都是同一种
占比条——第一行仪表自己的 `█`/`░` 字形、减半尺寸、单一填充色，不引入任何新视觉元素。
桶名和顺序与 Claude Code 面板逐字一致，唯一的例外：

| 行                   | 统计对象                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Used`               | provider 上报的上下文总量——下面的估算所对齐的真实数字                                                                                         |
| `Messages`           | 当前分支上的会话内容，包括工具结果、自定义消息和 compaction 摘要                                                                              |
| `Memory files`       | 渲染进系统提示的 context 文件（AGENTS.md、CLAUDE.md 等），带文件数                                                                            |
| `System tools`       | 实际发给 provider 的内置工具 JSON schema                                                                                                      |
| `Ext tools`          | 扩展、SDK 和 MCP 注册的工具 JSON schema，带工具数——这是唯一没有沿用 CC 名字的桶：pi 的非内置工具同时来自扩展和 MCP，叫 "MCP tools" 会标错大半 |
| `Skills`             | 系统提示里的 skills 段，带技能数                                                                                                              |
| `System prompt`      | 其余系统提示：身份、工具清单、规则、docs、cwd、扩展自定义段                                                                                   |
| `Unaccounted`        | Used 减估算和——估算的诚实残差，dim 显示；百分比列因此能加得起来                                                                               |
| `Autocompact buffer` | compaction 为模型回复预留的 token——来自 settings 的 `compaction.reserveTokens`；compaction 关闭时隐藏                                         |
| `Free space`         | 窗口减已用减预留。带仪表同源的 70/90 压力色，窗口将满时它会自己变色                                                                           |

除 `Used` 外每一行都是**估算值**，用的是 pi 自己的 chars/4 启发式（`core/compaction` 里的
`estimateTokens`）——这正是 `Unaccounted` 存在的原因：估算会偏离真实总量，面板把偏差亮出来，
而不是让百分比列加不平。Prompt 侧的份额是从本轮实际发送的提示原文里切出来的（在
`before_agent_start` 捕获），工具 schema 按 `pi.getAllTools()` 报告的激活工具集计算，这两处接近精确。

Claude Code 面板里有、而这里有意不做的：**Custom agents**（pi 没有子代理概念）和 **usage limits**
（特定厂商的订阅额度，pi 是多 provider 的）。**Deferred tools** 在 pi 里也没有对应物——
激活工具的 schema 永远在线上。

面板约 50 列宽，任何终端都放得下；放不下时逐行截断，而不是丢桶。开关键默认 `ctrl+q`——
`ctrl+j` 在传统终端里是一个裸 LF，和回车无法区分，`ctrl+e` 又撞上了 pi 内建的
光标移行尾（`tui.editor.cursorLineEnd`）；`ctrl+q` 在 pi 的默认键位里是空着的。如果你的机器上
`ctrl+q` 已被其他扩展占用，改 `index.ts` 顶部的 `BREAKDOWN_SHORTCUT` 即可。

可调项在 [`render.ts`](render.ts) 顶部：

| 常量           | 默认值  | 说明                                                    |
| -------------- | ------- | ------------------------------------------------------- |
| `BAR_CELLS`    | `20`    | 仪表宽度。想更安静就调窄，想要更高分辨率就调宽          |
| `BAR_FILL`     | `█`     | 填充字形                                                |
| `BAR_TRACK`    | `░`     | 设为 `""` 得到无轨道仪表，设为 `"─"` 得到细线轨道       |
| `QUIET_STATUS` | pi-lens | `[状态键, 正则]` 列表，匹配到的文本视为"无事发生"而隐藏 |

## 币种

pi 里所有模型价格都是美元，而且它的 `cost` 字段**不带任何单位**，所以 footer 无从知道你实际是按什么币种付的。
币种与汇率放在 `~/.pi/agent/statusline/config.json`——本扩展的所有文件（配置加状态）都集中在这个文件夹里：

```json
{
  "currency": {
    "code": "CNY"
  }
}
```

汇率有两种设法：

- **跟随市场。** 只写 `code` 不写汇率时，每天第一个会话会从 open.er-api.com 拉取当日汇率表，
  并把整张表缓存进文件（`rates` + `fetchedAt`），下个会话热启动；切换币种即时生效、离线也能切。
- **钉死。** 加上 `"perUsd": 7.12`，footer 永远用这个汇率、绝不联网——如果你的平台直接按人民币计费，
  这是正确选择：国内价目表不是美元价目表乘以市场汇率。

`code` 决定符号：`CNY` 和 `RMB` 得到 `¥`，`JPY` 得到 `JP¥`（两者永不混用），符号表还认 `USD`、
`EUR`、`GBP`、`HKD`、`TWD`、`SGD`、`KRW`、`INR`、`AUD`、`CAD`、`NZD`、`CHF`；表里没有的代码原样打印。
`symbol` 可覆盖这一切。

切换就是改 `code`，或者在检出里执行 `make currency CODE=JPY`。该文件每个会话只读一次，改完需 `/reload`。
文件存在但不可用时会给出通知，而不是静默继续显示美元。

## 指标口径

吞吐与延迟遵循 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 turn-metrics 契约
（`packages/client/ui-chat/src/client/contract/turn-metrics.ts`），数字格式也照抄：

```text
ttftMs   = firstTokenTime - stepStartTime
decodeMs = completedTime  - firstTokenTime
tok/s    = usage.output / (decodeMs / 1000)
```

所以速率**不含 prefill 和首 token 延迟**，这是业界标准的"输出 token/秒"。

- **回合结束后是精确值**：用 provider 上报的 `usage.output` 除以实测解码窗口。
- **流式期间是估算值**，前面带 `~`。provider 只在最后一个流式分片才回 usage，所以流式期间的 token 数
  由已流出字符数乘以"每字符 token 比"推断，该比值从本会话自己上报的 usage 学到。
- **TTFT 在首个 token 到达时就精确**，那一轮内不再变化。
- 读数在会话中**第一轮结束后**才出现，因为它只能来自流式事件。

## 要求与限制

- footer 只能有一个扩展占用。`ctx.ui.setFooter()` 是排他的，所以再装一个 footer 扩展是**竞争**而不是叠加。
  本扩展在检测到 [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) 时会主动让位，两者不会互相打架。
- footer 读取 `ctx.getContextUsage()`、`ctx.getSystemPrompt()`、`ctx.sessionManager`、
  `pi.getAllTools()`、`pi.getActiveTools()`，全部是公开 API，没有触碰 pi 内部实现。
- `MCP: 2 servers enabled` 这类信息性状态可以在源头关掉：`~/.pi/agent/mcp.json` 的
  `settings.mcpFooterStatus`。pi-lens 的 `LSP Inactive` 没有类似开关，所以在本地按"安静状态"过滤。

## 安装

```sh
# 单独安装
pi install npm:@reedchan/statusline

# 或作为合集的一部分安装，会装上本仓库的全部扩展
pi install npm:useful-pi-extensions
```

然后 `/reload`。
