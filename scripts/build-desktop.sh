#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"
node_version=22.22.0
node_sha=5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640
archive="build/downloads/node-v${node_version}-darwin-arm64.tar.gz"
app="build/HEAV3NS-CODE.app"
identity="${HEAV3NS_SIGN_IDENTITY:--}"
assert_bundle_idle() {
  if /usr/sbin/lsof -t "$task_root/$app/Contents/MacOS/HEAV3NS-CODE" "$task_root/$app/Contents/Resources/runtime/node" >/dev/null 2>&1; then
    echo 'Close the running desktop app and finish native transport tests before rebuilding this signed bundle.' >&2
    exit 1
  fi
}
assert_bundle_idle
test "$(uname -m)" = arm64 || { echo 'This preview supports arm64 only.' >&2; exit 1; }
mkdir -p build/downloads "$app/Contents/MacOS" "$app/Contents/Resources/runtime/dist"
if ! test -f "$archive"; then curl --fail --location --silent --show-error "https://nodejs.org/dist/v${node_version}/node-v${node_version}-darwin-arm64.tar.gz" -o "$archive"; fi
actual_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
test "$actual_sha" = "$node_sha" || { echo 'Bundled Node checksum mismatch.' >&2; exit 1; }
tar -xzf "$archive" -C build/downloads
npm run build
swift build --package-path native --configuration release --scratch-path build/native
assert_bundle_idle
cp build/native/release/HEAV3NS-CODE "$app/Contents/MacOS/HEAV3NS-CODE"
cp "build/downloads/node-v${node_version}-darwin-arm64/bin/node" "$app/Contents/Resources/runtime/node"
cp -R dist/. "$app/Contents/Resources/runtime/dist/"
mkdir -p "$app/Contents/Resources/runtime/node_modules"
cp -R node_modules/typescript "$app/Contents/Resources/runtime/node_modules/"
cp LICENSE NOTICE THIRD-PARTY-NOTICES.md LICENSE-MAP.md TRADEMARKS.md "$app/Contents/Resources/"
cp "build/downloads/node-v${node_version}-darwin-arm64/LICENSE" "$app/Contents/Resources/NODE-LICENSE"
cp native/Info.plist "$app/Contents/Info.plist"
codesign --force --sign "$identity" --options runtime --entitlements native/Node.entitlements "$app/Contents/Resources/runtime/node"
codesign --force --sign "$identity" --options runtime "$app"
codesign --verify --deep --strict "$app"
echo "Built $task_root/$app"
if test "$identity" = -; then echo 'Ad-hoc development signature. Developer ID and notarization are not verified.'; fi
