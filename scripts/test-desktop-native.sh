#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)" in
  Darwin) exec swift test --package-path native --scratch-path build/native-tests ;;
  *) echo 'Native desktop tests support macOS only.' >&2; exit 1 ;;
esac
