# useful-pi-extensions — one entry point for checking and installing the
# extensions in this repository.
#
# Development uses Bun for type checking and tests. pi loads the extensions
# straight out of ./extensions, so there is no build step and no bundling: what
# is in the tree is what pi runs.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- configuration ----------------------------------------------------------

# Git remote users install from; matches the `pi install` spec below.
REMOTE ?= github.com/reedchan7/useful-pi-extensions
# Tag pinned by `make install-github`.
TAG ?= v0.1.0
# One-time password from an authenticator app. npm requires 2FA for every publish,
# so `make publish OTP=123456` is the interactive path.
OTP ?=

##
## Help
##

.PHONY: help
help: ## Show this help
	@printf 'useful-pi-extensions\n\n'
	@printf 'Usage: make <target> [TAG=%s]\n' '$(TAG)'
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
pack: ## Show the exact tarball npm would publish
	npm pack --dry-run

.PHONY: publish
publish: ## Publish to npmjs.com (needs `npm login` + `OTP=` unless a bypass-2FA token is set)
	npm publish --access public $(if $(OTP),--otp=$(OTP),)
	@printf '\nthe gallery at https://pi.dev/packages indexes it within minutes\n'

##
## Install into pi
##

.PHONY: install-local
install-local: ## Install this checkout into pi
	pi install $(CURDIR)

.PHONY: install-github
install-github: ## Install the pinned git ref into pi
	pi install git:$(REMOTE)@$(TAG)

.PHONY: uninstall
uninstall: ## Remove this checkout from pi
	pi remove $(CURDIR)
