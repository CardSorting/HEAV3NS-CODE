#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION=2.10.0
SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
DEPS="$ROOT/build/deps"
ARCHIVE="$DEPS/Sparkle-${VERSION}.tar.xz"
DEST="$DEPS/sparkle-${VERSION}"
mkdir -p "$DEPS"
if [[ ! -f "$ARCHIVE" ]]; then
    curl --fail --location --silent --show-error --retry 2 \
        --proto '=https' --proto-redir '=https' \
        "https://github.com/sparkle-project/Sparkle/releases/download/${VERSION}/Sparkle-${VERSION}.tar.xz" \
        --output "$ARCHIVE"
fi
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | shasum -a 256 --check >&2
if [[ ! -d "$DEST/Sparkle.framework" ]]; then
    mkdir -p "$DEST"
    tar -xf "$ARCHIVE" -C "$DEST"
fi
printf '%s\n' "$DEST"
