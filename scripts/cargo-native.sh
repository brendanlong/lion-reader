#!/usr/bin/env bash
# Run one cargo command in the native/ workspace, falling back to
# ~/.cargo/bin when cargo isn't on PATH.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <cargo args...>" >&2
  exit 64
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v cargo >/dev/null 2>&1; then
  if [ -x "${HOME:-}/.cargo/bin/cargo" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    echo "cargo not found on PATH or in ~/.cargo/bin; install the Rust toolchain" >&2
    exit 69
  fi
fi

cd "$root/native"
exec cargo "$@"
