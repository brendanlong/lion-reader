#!/usr/bin/env bash
# Run one cargo command in every native/ crate.
#
# Each native module is its own standalone cargo workspace (see the `[workspace]`
# stanzas in native/*/Cargo.toml), so there is no repo-level `--workspace` that
# reaches all of them.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <cargo args...>" >&2
  exit 64
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

status=0
for manifest in "$root"/native/*/Cargo.toml; do
  crate="$(basename "$(dirname "$manifest")")"
  echo "==> native/$crate: cargo $*"
  # Keep going after a failure so one run reports every crate's problems.
  (cd "$(dirname "$manifest")" && cargo "$@") || status=1
done

exit $status
