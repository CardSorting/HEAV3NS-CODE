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
mkdir -p build/downloads "$app/Contents/MacOS" "$app/Contents/Resources/runtime/dist" "$app/Contents/Frameworks"
if ! test -f "$archive"; then curl --fail --location --silent --show-error "https://nodejs.org/dist/v${node_version}/node-v${node_version}-darwin-arm64.tar.gz" -o "$archive"; fi
actual_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
test "$actual_sha" = "$node_sha" || { echo 'Bundled Node checksum mismatch.' >&2; exit 1; }
tar -xzf "$archive" -C build/downloads
npm run build
swift build --package-path native --configuration release --scratch-path build/native
assert_bundle_idle
cp build/native/release/HEAV3NS-CODE "$app/Contents/MacOS/HEAV3NS-CODE"
if ! otool -l "$app/Contents/MacOS/HEAV3NS-CODE" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$app/Contents/MacOS/HEAV3NS-CODE"
fi
rm -rf "$app/Contents/Frameworks/Sparkle.framework"
cp -R build/native/release/Sparkle.framework "$app/Contents/Frameworks/"
cp native/Assets/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cp -R build/native/release/HEAV3NS-CODE_Heav3nsCode.bundle "$app/Contents/Resources/"
cp "build/downloads/node-v${node_version}-darwin-arm64/bin/node" "$app/Contents/Resources/runtime/node"
rm -rf "$app/Contents/Resources/runtime/dist"
mkdir -p "$app/Contents/Resources/runtime/dist"
rsync -a --exclude="gumroad" --exclude="releases" --exclude="*.map" dist/ "$app/Contents/Resources/runtime/dist/"
mkdir -p "$app/Contents/Resources/runtime/node_modules"
cp -R node_modules/typescript "$app/Contents/Resources/runtime/node_modules/"
cp LICENSE NOTICE THIRD-PARTY-NOTICES.md LICENSE-MAP.md TRADEMARKS.md PATENT-NON-AGGRESSION-PLEDGE.md "$app/Contents/Resources/"
cp "build/downloads/node-v${node_version}-darwin-arm64/LICENSE" "$app/Contents/Resources/NODE-LICENSE"
cp native/Info.plist "$app/Contents/Info.plist"
find "$app" -name ".DS_Store" -delete 2>/dev/null || true
xattr -cr "$app"
sign_opts=(--options runtime)
if test "$identity" != "-"; then
  sign_opts+=(--timestamp)
fi

if test -d "$app/Contents/Frameworks/Sparkle.framework"; then
  sparkle_root="$app/Contents/Frameworks/Sparkle.framework"
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/XPCServices/Downloader.xpc"
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/XPCServices/Installer.xpc"
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/Autoupdate"
  if test -f "$sparkle_root/Versions/B/Updater.app/Contents/MacOS/Updater"; then
    codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/Updater.app/Contents/MacOS/Updater"
  fi
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/Updater.app"
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root/Versions/B/Sparkle"
  codesign --force --sign "$identity" "${sign_opts[@]}" "$sparkle_root"
fi
codesign --force --sign "$identity" "${sign_opts[@]}" --entitlements native/Node.entitlements "$app/Contents/Resources/runtime/node"
codesign --force --sign "$identity" "${sign_opts[@]}" --entitlements native/App.entitlements "$app/Contents/MacOS/HEAV3NS-CODE"
codesign --force --sign "$identity" "${sign_opts[@]}" --entitlements native/App.entitlements "$app"
codesign --verify --deep --strict "$app"
echo "Built $task_root/$app"
if test "$identity" = -; then echo 'Ad-hoc development signature. Developer ID and notarization are not verified.'; fi
