# useful-pi-extensions

[English](README.md) | 中文

一组 [pi](https://pi.dev) 扩展，一行命令即可安装。

```sh
pi install git:github.com/reedchan7/useful-pi-extensions
```

## 包含什么

| 扩展                                               | 作用                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`statusline`](extensions/statusline/README_CN.md) | 替换 pi 的 footer，改成带文字标签的两行：上下文压力用固定宽度仪表显示，外加缓存与花费、模型与思考等级，以及最近一轮的 TTFT 和解码速度（tok/s） |

footer 只能有一个扩展占用，所以 `statusline` 是**替换**而不是叠加。想回到 pi 原生 footer，移除本包再 `/reload`。

## 效果图

### statusline

<img width="897" height="45" alt="Warp 2026-09-18 16 20 27" src="https://github.com/user-attachments/assets/7ae64213-cb05-4440-835e-a633796a87f9" />

## 安装

```sh
# 从仓库安装
pi install git:github.com/reedchan7/useful-pi-extensions

# 锁定标签
pi install git:github.com/reedchan7/useful-pi-extensions@v0.1.0

# 从本地检出安装（开发用）
pi install /absolute/path/to/useful-pi-extensions
```

然后在运行中的会话里执行 `/reload`，或直接新开一个会话。

> **先删掉散装的那份。** 如果你之前把扩展作为单文件放在 `~/.pi/agent/extensions/`，
> 安装本包之前请先删掉那个文件。两份会同时加载，两个 footer 抢同一个位置——
> 后加载的赢，而谁后加载没有意义。

## 环境要求

- pi 0.85 或更新（`pi --version`）
- 无运行期依赖。`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui` 是 peer
  dependency，由 pi 自身提供。

## 目录结构

```
extensions/            # 每个子目录是一个扩展；pi 发现 <name>/index.ts
  statusline/
    index.ts           # pi 入口：事件与 footer 接线
    render.ts          # 纯函数：数字格式化、仪表、行布局
    render.test.ts     # render.ts 的单元测试
```

`package.json` 声明 `"pi": { "extensions": ["./extensions"] }`，并带 `pi-package` 关键字以便被发现。
pi 读取该清单，找到每个 `extensions/*/index.ts` 并加载——无构建、无打包。

## 开发

```sh
make install      # bun install
make check        # 全部门禁：格式、lint、类型、文档配对、单测
make hooks        # 安装 git hooks（只需一次，需要已 git init）
make help         # 列出所有目标
```

`make check` 与 CI 跑同一套门禁：

| 门禁 | 命令                 | 强制内容                                                                                                                                             |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 格式 | `bun run fmt:check`  | oxfmt：100 列、单引号、无分号                                                                                                                        |
| Lint | `bun run lint`       | oxlint 类型感知模式 + `--deny-warnings`，即 **warning 也判失败**                                                                                     |
| 类型 | `bun run typecheck`  | `--strict` 以及 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`，这正是保证每个文件无需转译就能被 pi 直接加载的原因 |
| 文档 | `bun run docs:check` | 每个 `README.md` 都有 `README_CN.md`，标题层级序列一致且语言切换链接可用                                                                             |
| 单测 | `bun test`           | `extensions/*/` 下的单元测试                                                                                                                         |

提交遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`commit-msg` 钩子会拒绝不符合
`type(scope): summary` 的标题，pre-commit 钩子只对暂存文件做格式化与 lint。工具链在 `package.json`
中锁定精确版本（`bunfig.toml` 设了 `install.exact = true`）。`@earendil-works/*` 刻意保留为 `*`：
它们是 pi 提供的宿主 API，跟随它才能尽早发现上游变更。

## 许可

MIT，见 [LICENSE](LICENSE)。
