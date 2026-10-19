#!/usr/bin/env bash
# Git hook helper: rebuild the native modules when HEAD's native/ tree differs
# from the one they were last rebuilt from here, so no checkout, merge or rebase
# leaves a binary built from other Rust sources. Checkouts that have never
# built them are left alone.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
stamp="$root/native/.built-tree"

compgen -G "$root/native/*/*.node" >/dev/null || exit 0
tree="$(git rev-parse HEAD:native)"
[ "$(cat "$stamp" 2>/dev/null)" = "$tree" ] && exit 0

export PATH="${HOME:-}/.cargo/bin:$PATH"
echo "native/ changed; running pnpm build:native"
if (cd "$root" && pnpm build:native); then
  echo "$tree" >"$stamp"
else
  echo "pnpm build:native failed; rerun it before using the app or tests" >&2
fi
