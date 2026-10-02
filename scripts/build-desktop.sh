#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$(uname -s)}"
if test "$#" -gt 0; then shift; fi
case "$target" in
  Darwin|darwin|macos) exec bash "$root/scripts/build-desktop-macos.sh" "$@" ;;
  Linux|linux) exec bash "$root/scripts/build-desktop-linux.sh" "$@" ;;
  *) echo "Unsupported desktop platform: $target (choose macos or linux)." >&2; exit 1 ;;
esac
