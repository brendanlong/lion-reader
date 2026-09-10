#!/usr/bin/env bash
# Format the .rs files lint-staged hands us, for the husky pre-commit hook.
#
# `cargo fmt` formats a whole crate, not the paths lint-staged passes, so call
# rustfmt directly. Its `--edition` has to match the owning crate's, or the hook
# formats to a different dialect than `cargo fmt` does in CI; derive it from the
# nearest Cargo.toml rather than hardcoding one, so a crate that moves editions
# does not silently start disagreeing with the CI gate. Staged files can span
# several crates, hence the grouping.
set -euo pipefail

if [ $# -eq 0 ]; then
  exit 0
fi

if ! command -v rustfmt >/dev/null 2>&1; then
  if [ -x "${HOME:-}/.cargo/bin/rustfmt" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    echo "rustfmt not found on PATH or in ~/.cargo/bin; install the Rust toolchain" >&2
    exit 69
  fi
fi

edition_of() {
  local dir
  dir="$(cd "$(dirname "$1")" && pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/Cargo.toml" ]; then
      local edition
      edition="$(sed -n 's/^edition[[:space:]]*=[[:space:]]*"\([0-9]\{4\}\)".*/\1/p' "$dir/Cargo.toml" | head -1)"
      if [ -n "$edition" ]; then
        echo "$edition"
        return
      fi
    fi
    dir="$(dirname "$dir")"
  done
  # A .rs file outside any crate; rustfmt's own default.
  echo 2015
}

editions=()
for file in "$@"; do
  editions+=("$(edition_of "$file")")
done

for edition in $(printf '%s\n' "${editions[@]}" | sort -u); do
  group=()
  for i in "${!editions[@]}"; do
    if [ "${editions[$i]}" = "$edition" ]; then
      group+=("${@:i+1:1}")
    fi
  done
  rustfmt --edition "$edition" "${group[@]}"
done
