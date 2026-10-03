#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$(uname -s)}"
if test "$#" -gt 0; then shift; fi
case "$target" in
  Darwin|darwin|macos) exec bash "$root/scripts/build-desktop-macos.sh" "$@" ;;
  *) echo "Unsupported desktop platform: $target (only macos is supported)." >&2; exit 1 ;;
esac
