# useful-pi-extensions — one entry point for checking, publishing and installing
# the packages in this repository.
#
# The repository root is the collection package and each extension under packages/ is
# published on its own. pi loads the extensions straight out of the tree, so there is
# no build step and no bundling: what is in the tree is what pi runs.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- configuration ----------------------------------------------------------

# Git remote users install from; matches the `pi install` spec below.
REMOTE ?= github.com/reedchan7/useful-pi-extensions
# Tag pinned by `make install-github`.
TAG ?= v1.1.2
# Restrict a publish to one package, by its npm name: PKG=@reedchan/statusline
PKG ?=
# DRY=1 walks the whole publish path and publishes nothing.
DRY ?=
# The extension as pi refers to it on this machine: see install-npm / update-npm / remove-npm.
PI_PKG ?= npm:@reedchan/statusline

##
## Help
##

.PHONY: help
help: ## Show this help
	@printf 'useful-pi-extensions\n\n'
	@printf 'Usage: make <target> [TAG=%s] [PKG=%s] [DRY=%s] [PI_PKG=%s]\n' '$(TAG)' '$(PKG)' '$(DRY)' '$(PI_PKG)'
	@awk ' \
		/^## [A-Za-z]/ { sub(/^## /, ""); printf "\n\033[1m%s\033[0m\n", $$0; next } \
		/^[a-zA-Z0-9_-]+:.*## / { \
			split($$0, parts, "## "); \
			split(parts[1], name, ":"); \
			printf "  \033[36m%-16s\033[0m %s\n", name[1], parts[2]; \
		} \
	' $(MAKEFILE_LIST)
	@printf '\n'

##
## Quality
##

.PHONY: fmt
fmt: ## Format every file
	bun run fmt

.PHONY: fmt-check
fmt-check: ## Check formatting without writing
	bun run fmt:check

.PHONY: lint
lint: ## Lint every file
	bun run lint

.PHONY: hooks
hooks: ## Install the git hooks (lefthook)
	bunx lefthook install

##
## Development
##

.PHONY: install
install: ## Install development dependencies
	bun install

.PHONY: check
check: ## Format check, lint, type check, docs pairing and unit tests
	bun run check

.PHONY: test
test: ## Run the unit tests
	bun test

.PHONY: typecheck
typecheck: ## Type check every source file
	bun run typecheck

.PHONY: docs-check
docs-check: ## Verify every README has its README_CN counterpart
	bun run docs:check

##
## Publish
##

.PHONY: pack
pack: ## Show the exact tarballs npm would publish
	@for dir in . packages/*/; do \
		printf '\n\033[1m== %s\033[0m\n' "$$dir"; \
		(cd "$$dir" && npm pack --dry-run); \
	done

.PHONY: publish
publish: ## Publish the packages whose version is not on npm yet
	bun run publish:changed $(if $(PKG),--only $(PKG),) $(if $(DRY),--dry-run,)

##
## Install into pi
##

.PHONY: install-local
install-local: ## Install this checkout's collection into pi (live tree; /reload to apply)
	pi install $(CURDIR)

.PHONY: install-npm
install-npm: ## Install the published extension into pi
	pi install $(PI_PKG)

.PHONY: update-npm
update-npm: ## Update the installed extension to the latest published release
	pi update $(PI_PKG)

.PHONY: remove-npm
remove-npm: ## Remove the installed extension from pi
	pi remove $(PI_PKG)

.PHONY: currency
currency: ## Switch the display currency: make currency CODE=JPY
	bun tools/set-currency/src/index.ts $(CODE)

.PHONY: install-github
install-github: ## Install the pinned git ref into pi
	pi install git:$(REMOTE)@$(TAG)

.PHONY: uninstall
uninstall: ## Remove this checkout's collection from pi
	pi remove $(CURDIR)
