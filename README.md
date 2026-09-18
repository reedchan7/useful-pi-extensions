# useful-pi-extensions

English | [中文](README_CN.md)

A small collection of [pi](https://pi.dev) extensions, installed with one command.

```sh
pi install git:github.com/reedchan7/useful-pi-extensions
```

## What is in here

| Extension                                       | What it does                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`statusline`](extensions/statusline/README.md) | Replaces pi's footer with a labelled two-row one: context pressure as a fixed-size meter, cache and cost, the model and effort level, and the latest turn's TTFT and decode throughput in tokens/second |

Only one extension owns the footer, so `statusline` is a complete replacement rather than an
addition. If you want pi's stock footer back, remove this package and `/reload`.

## Screenshots

### statusline

<img width="897" height="45" alt="Warp 2026-09-18 16 20 27" src="https://github.com/user-attachments/assets/7ae64213-cb05-4440-835e-a633796a87f9" />


## Install

```sh
# from the repository
pi install git:github.com/reedchan7/useful-pi-extensions

# pinned to a tag
pi install git:github.com/reedchan7/useful-pi-extensions@v0.1.0

# from a local checkout (development)
pi install /absolute/path/to/useful-pi-extensions
```

Then reload pi in the running session with `/reload`, or start a new one.

> **Removing a loose copy first.** If you were running the extension as a single file in
> `~/.pi/agent/extensions/`, delete that file before installing this package. Both would load, and
> two footers race for the same slot — the later one wins, which decides nothing useful.

## Requirements

- pi 0.85 or newer (`pi --version`)
- No runtime dependencies. `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are
  peer dependencies supplied by pi itself.

## Layout

```
extensions/            # each subdirectory is one extension; pi discovers <name>/index.ts
  statusline/
    index.ts           # pi entry point: events and footer wiring
    render.ts          # pure helpers: number formatting, the meter, row layout
    render.test.ts     # unit tests for render.ts
```

`package.json` declares `"pi": { "extensions": ["./extensions"] }` and carries the `pi-package`
keyword so the package is discoverable. pi resolves the manifest, finds every
`extensions/*/index.ts`, and loads it — no build step, no bundling.

## Development

```sh
make install      # bun install
make check        # every gate: format, lint, types, docs pairing, tests
make hooks        # install the git hooks (run once, needs a git checkout)
make help         # list every target
```

`make check` runs the same gates as CI:

| Gate   | Command              | What it enforces                                                                                                                                                       |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format | `bun run fmt:check`  | oxfmt: 100 columns, single quotes, no semicolons                                                                                                                       |
| Lint   | `bun run lint`       | oxlint in type-aware mode with `--deny-warnings`, so a warning fails the run                                                                                           |
| Types  | `bun run typecheck`  | `--strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, which is what keeps every file loadable by pi without a transform |
| Docs   | `bun run docs:check` | every `README.md` has a `README_CN.md` with the same heading sequence and a working language switcher                                                                  |
| Tests  | `bun test`           | the unit tests under `extensions/*/`                                                                                                                                   |

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): the `commit-msg` hook
rejects a subject that is not `type(scope): summary`, and the pre-commit hook formats and lints only
the staged files. The toolchain is pinned to exact versions in `package.json` (`bunfig.toml` sets
`install.exact = true`). The `@earendil-works/*` packages are deliberately left at `*`: they are the
host API pi supplies, and tracking it is what surfaces an upstream break early.

## License

MIT. See [LICENSE](LICENSE).
