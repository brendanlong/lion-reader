#!/usr/bin/env bash
# Git hook helper: rebuild the native modules when native/ changed between two
# commits, so a checkout never imports a binary built from older Rust sources.
# Checkouts that have never built them (e.g. a fresh worktree) are left alone;
# the first `pnpm build:native` there is still manual.
set -euo pipefail

old="$1"
new="$2"
root="$(git rev-parse --show-toplevel)"

compgen -G "$root/native/*/*.node" >/dev/null || exit 0
git diff --quiet "$old" "$new" -- native/ 2>/dev/null && exit 0

export PATH="${HOME:-}/.cargo/bin:$PATH"
echo "native/ changed; running pnpm build:native"
(cd "$root" && pnpm build:native) || echo "pnpm build:native failed; rerun it before using the app or tests" >&2
