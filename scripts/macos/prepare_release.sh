#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${HEAV3NS_SIGN_IDENTITY:?Set HEAV3NS_SIGN_IDENTITY to the Developer ID Application identity}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE to the stored Apple notarytool profile}"
[[ "$HEAV3NS_SIGN_IDENTITY" == 'Developer ID Application:'* ]] || exit 1
ARCH="${HEAV3NS_BUILD_ARCH:-$(uname -m)}"
[[ "$ARCH" == arm64 || "$ARCH" == x86_64 ]] || exit 1
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' native/Info.plist)"
TAG="v${VERSION}"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "refs/tags/${TAG}^{commit}")" && -z "$(git status --porcelain)" ]] || {
  echo 'Prepare releases from the clean matching native source tag.' >&2; exit 1;
}
SPARKLE="$(bash scripts/macos/fetch_sparkle.sh)"
KEY="$("$SPARKLE/bin/generate_keys" -p)"
[[ "$KEY" == "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' native/Info.plist)" ]] || {
  echo 'The Keychain signing key does not match the deployed app update key.' >&2; exit 1;
}
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null
BASE="$ROOT/build/release"
DEST="$BASE/${TAG}-${ARCH}"
mkdir -p "$BASE"
[[ ! -e "$DEST" && ! -L "$DEST" ]] || { echo "Output already exists: $DEST" >&2; exit 1; }
LOCK="$BASE/.${TAG}-${ARCH}.lock"
mkdir "$LOCK" || exit 1
WORK="$(mktemp -d "$BASE/.${TAG}-${ARCH}.XXXXXX")"
cleanup() { rm -rf "$WORK"; rmdir "$LOCK"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
HEAV3NS_BUILD_OUTPUT_DIR="$WORK/output" bash scripts/build-desktop-macos.sh
APP="$WORK/output/HEAV3NS-CODE.app"
codesign --verify --deep --strict -R='anchor apple generic and identifier "io.heav3ns.code" and certificate leaf[subject.OU] = "C35F6CCNLU"' "$APP"
spctl --assess --type execute "$APP"
xcrun stapler validate "$APP"
mkdir "$WORK/assets" "$WORK/dmg-source"
ZIP="HEAV3NS-CODE-macOS-${ARCH}.zip"
DMG="HEAV3NS-CODE-macOS-${ARCH}.dmg"
cp "$WORK/output/HEAV3NS-CODE-macOS.zip" "$WORK/assets/$ZIP"
cp "$WORK/output/app-notarization.json" "$WORK/assets/app-notarization.json"
ditto "$APP" "$WORK/dmg-source/HEAV3NS-CODE.app"
ln -s /Applications "$WORK/dmg-source/Applications"
hdiutil create -quiet -volname HEAV3NS-CODE -srcfolder "$WORK/dmg-source" -ov -format UDZO "$WORK/assets/$DMG"
codesign --force --timestamp --sign "$HEAV3NS_SIGN_IDENTITY" "$WORK/assets/$DMG"
xcrun notarytool submit "$WORK/assets/$DMG" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$WORK/assets/dmg-notarization.json"
[[ "$(plutil -extract status raw -o - "$WORK/assets/dmg-notarization.json")" == Accepted ]] || exit 1
xcrun stapler staple "$WORK/assets/$DMG"
xcrun stapler validate "$WORK/assets/$DMG"
( cd "$WORK/assets"; shasum -a 256 "$ZIP" "$DMG" > SHA256SUMS.txt )
mv "$WORK/assets" "$DEST"
echo "Prepared signed and notarized $DEST"
