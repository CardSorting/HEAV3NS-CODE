#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"
arch="${HEAV3NS_BUILD_ARCH:-$(uname -m)}"
case "$arch" in
  arm64) node_arch=arm64; node_sha=5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640 ;;
  x86_64) node_arch=x64; node_sha=5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce ;;
  *) echo 'Use HEAV3NS_BUILD_ARCH=arm64 or x86_64.' >&2; exit 1 ;;
esac
node_version=22.22.0
archive="$task_root/build/downloads/node-v${node_version}-darwin-${node_arch}.tar.gz"
output="${HEAV3NS_BUILD_OUTPUT_DIR:-$task_root/build}"
[[ "$output" == /* ]] || output="$task_root/$output"
identity="${HEAV3NS_SIGN_IDENTITY:--}"
mkdir -p "$task_root/build/downloads" "$output"
lock="$output/.desktop-build.lock"
mkdir "$lock" || { echo 'Another desktop build may be in progress.' >&2; exit 1; }
stage="$(mktemp -d "$output/.desktop-build.XXXXXX")"
cleanup() { rm -rf "$stage"; rmdir "$lock"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
app="$stage/HEAV3NS-CODE.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/dist" "$app/Contents/Frameworks"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --silent --show-error --retry 2 --proto '=https' --proto-redir '=https' \
    "https://nodejs.org/dist/v${node_version}/node-v${node_version}-darwin-${node_arch}.tar.gz" -o "$archive"
fi
printf '%s  %s\n' "$node_sha" "$archive" | shasum -a 256 --check
tar -xzf "$archive" -C build/downloads
npm run build
swift build --package-path native --configuration release --arch "$arch" --scratch-path "build/native-${arch}"
bin="$(swift build --package-path native --configuration release --arch "$arch" --scratch-path "build/native-${arch}" --show-bin-path)"
cp "$bin/HEAV3NS-CODE" "$app/Contents/MacOS/HEAV3NS-CODE"
if ! otool -l "$app/Contents/MacOS/HEAV3NS-CODE" | grep -q '@executable_path/../Frameworks'; then
  install_name_tool -add_rpath '@executable_path/../Frameworks' "$app/Contents/MacOS/HEAV3NS-CODE"
fi
ditto "$bin/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
ditto "$bin/HEAV3NS-CODE_Heav3nsCode.bundle" "$app/Contents/Resources/HEAV3NS-CODE_Heav3nsCode.bundle"
cp native/Assets/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cp "build/downloads/node-v${node_version}-darwin-${node_arch}/bin/node" "$app/Contents/Resources/runtime/node"
rsync -a --exclude=gumroad --exclude=releases --exclude='*.map' dist/ "$app/Contents/Resources/runtime/dist/"
mkdir "$app/Contents/Resources/runtime/node_modules"
ditto node_modules/typescript "$app/Contents/Resources/runtime/node_modules/typescript"
cp LICENSE NOTICE THIRD-PARTY-NOTICES.md LICENSE-MAP.md TRADEMARKS.md PATENT-NON-AGGRESSION-PLEDGE.md "$app/Contents/Resources/"
cp "build/downloads/node-v${node_version}-darwin-${node_arch}/LICENSE" "$app/Contents/Resources/NODE-LICENSE"
cp native/Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SUFeedURL https://raw.githubusercontent.com/CardSorting/HEAV3NS-CODE-Releases/main/appcast-${arch}.xml" "$app/Contents/Info.plist"
sign_opts=(--force --options runtime)
[[ "$identity" == - ]] || sign_opts+=(--timestamp)
framework="$app/Contents/Frameworks/Sparkle.framework"
for helper in "$framework/Versions/B/XPCServices/Downloader.xpc" "$framework/Versions/B/XPCServices/Installer.xpc" "$framework/Versions/B/Autoupdate" "$framework/Versions/B/Updater.app" "$framework"; do
  codesign "${sign_opts[@]}" --sign "$identity" "$helper"
done
codesign "${sign_opts[@]}" --sign "$identity" --entitlements native/Node.entitlements "$app/Contents/Resources/runtime/node"
entitlements=native/App.entitlements
if [[ "$identity" == - ]]; then
  entitlements="$stage/development.entitlements"
  printf '%s\n' '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>' > "$entitlements"
fi
codesign "${sign_opts[@]}" --sign "$identity" --entitlements "$entitlements" "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$stage/HEAV3NS-CODE-macOS.zip"
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  [[ "$identity" != - ]] || { echo 'Notarization requires Developer ID signing.' >&2; exit 1; }
  xcrun notarytool submit "$stage/HEAV3NS-CODE-macOS.zip" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$stage/app-notarization.json"
  [[ "$(plutil -extract status raw -o - "$stage/app-notarization.json")" == Accepted ]] || { echo 'App notarization was not accepted.' >&2; exit 1; }
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$stage/HEAV3NS-CODE-macOS.zip"
  mv "$stage/app-notarization.json" "$output/app-notarization.json"
fi
if /usr/sbin/lsof -t "$output/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE" "$output/HEAV3NS-CODE.app/Contents/Resources/runtime/node" >/dev/null 2>&1; then
  echo 'Close the existing output app before installing this build.' >&2; exit 1
fi
python3 scripts/macos/install_bundle.py "$app" "$output/HEAV3NS-CODE.app"
mv "$stage/HEAV3NS-CODE-macOS.zip" "$output/HEAV3NS-CODE-macOS.zip"
echo "Built $output/HEAV3NS-CODE.app ($arch)"
