#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

buf lint proto

# Lint must be read-only, and an invalid schema or format must fail CI.
buf format proto --diff --exit-code

if grep -rn "rpc .*[A-Z][A-Z].*[(]" --include="*.proto" proto; then
  # See https://github.com/dietcode/dietcode/pull/7054
  echo Error: Proto RPC names cannot contain repeated capital letters
  exit 1
fi
