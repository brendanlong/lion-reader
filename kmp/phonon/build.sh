#!/bin/bash
# Builds Phonon's C library (libptts_ffi.so, behind PhononTts.kt) for the app from Gradium's
# source at a pinned commit, the way their android/build.sh does.
#   build.sh <jniLibs dir> <work dir> <minSdk>
# Needs rustup, cargo-ndk and an NDK it can find (ANDROID_NDK_HOME); it installs the Rust the
# repo's rust-toolchain.toml pins, with the Android targets. Gradle runs it (androidApp's buildPhonon task) when this file changes.
set -euo pipefail

# The xn-ptts release tag, its commit, and the SHA-256 of GitHub's archive of that commit.
VERSION=v0.6.0
COMMIT=95bf24d1ca5e94f0f62abe588b1ccb6f093bcc9c
SHA256=0c49b01bc003ee4d71d13d1b01de7d16ffd1bf2609646e55c7f2d58c5da9f266

mkdir -p "$1" "$2"
out="$(cd "$1" && pwd)"
work="$(cd "$2" && pwd)"
min_sdk="$3"
src="$work/xn-ptts-$COMMIT"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -d "$src" ]; then
  rm -rf "$work"/xn-ptts-*
  mkdir -p "$work"
  curl -fsSL "https://codeload.github.com/gradium-ai/xn-ptts/tar.gz/$COMMIT" -o "$work/src.tgz"
  # sha256sum on Linux, shasum on macOS.
  if command -v sha256sum >/dev/null; then check=(sha256sum -c --quiet -); else check=(shasum -a 256 -c -s -); fi
  echo "$SHA256  $work/src.tgz" | "${check[@]}"
  tar -xzf "$work/src.tgz" -C "$work"
  rm "$work/src.tgz"
fi

# The repo's toolchain, not whatever rustup defaults to in Gradium's tree (it pins none).
export RUSTUP_TOOLCHAIN
RUSTUP_TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$repo/rust-toolchain.toml")"
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal \
  --target aarch64-linux-android,x86_64-linux-android >/dev/null

# As android/build.sh: xn picks its kernels at compile time, so the CPU features are fixed here
# (dotprod and fp16, on about every phone since 2019; the app reports enhanced voices as
# unavailable where the library won't load). These replace .cargo/config.toml's
# target-cpu=native. Play requires 16 KB pages from Android 15.
common="-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$common -C target-cpu=generic -C target-feature=+dotprod,+fp16"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="$common -C target-cpu=x86-64"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

rm -rf "$out"
# Outside the source tree, so CI's cache of it survives the source being extracted again.
export CARGO_TARGET_DIR="$work/target"
cd "$src"
cargo ndk -t arm64-v8a -t x86_64 --platform "$min_sdk" -o "$out" build --release --locked -p ptts-ffi
echo "Built Phonon $VERSION: $(du -sh "$out"/*/libptts_ffi.so | tr '\n' ' ')"
