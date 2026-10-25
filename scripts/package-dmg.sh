#!/bin/bash
# The legacy unsigned/Gatekeeper-bypass package path has been retired.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/macos/prepare_release.sh" "$@"
