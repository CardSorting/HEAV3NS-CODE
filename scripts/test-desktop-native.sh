#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)" in
  Darwin) exec swift test --package-path native --scratch-path build/native-tests ;;
  Linux) exec python3 -m unittest discover -s native/linux/tests -v ;;
  *) echo 'Native desktop tests support macOS and Linux.' >&2; exit 1 ;;
esac
