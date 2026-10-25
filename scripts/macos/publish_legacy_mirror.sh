#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' native/Info.plist)"
TAG="v${VERSION}"
REPO=CardSorting/HEAV3NS-CODE-Releases
WRANGLER="${HEAV3NS_WRANGLER:-$ROOT/node_modules/.bin/wrangler}"
[[ -x "$WRANGLER" ]] || { echo 'Set HEAV3NS_WRANGLER to a Wrangler 4 CLI.' >&2; exit 1; }
SPARKLE="$(bash scripts/macos/fetch_sparkle.sh)"
WORK="$(mktemp -d "$ROOT/build/.legacy-mirror.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
gh release download "$TAG" --repo "$REPO" --dir "$WORK"
( cd "$WORK"; shasum -a 256 --check SHA256SUMS.txt )
FEED_REVISION="$(gh api "repos/$REPO/commits/main" --jq .sha)"
for ARCH in arm64 x86_64; do
    cmp "$ROOT/build/release/${TAG}-${ARCH}/HEAV3NS-CODE-macOS-${ARCH}.zip" "$WORK/HEAV3NS-CODE-macOS-${ARCH}.zip"
    curl --fail --location --silent --show-error --retry 2 --proto '=https' --proto-redir '=https' \
        "https://raw.githubusercontent.com/$REPO/$FEED_REVISION/appcast-${ARCH}.xml" --output "$WORK/appcast-${ARCH}.xml"
    "$SPARKLE/bin/sign_update" --verify "$WORK/appcast-${ARCH}.xml"
done
python3 scripts/macos/create_mirror_manifest.py "$WORK"
for ARCH in arm64 x86_64; do
    for EXT in dmg zip; do
        TYPE=application/octet-stream
        [[ "$EXT" != zip ]] || TYPE=application/zip
        "$WRANGLER" r2 object put "heav3ns-releases/HEAV3NS-CODE-${TAG}-macOS-${ARCH}.${EXT}" \
            --remote --file "$WORK/HEAV3NS-CODE-macOS-${ARCH}.${EXT}" --content-type "$TYPE" --cache-control 'public, max-age=31536000, immutable'
    done
done
for EXT in dmg zip; do
    "$WRANGLER" r2 object put "heav3ns-releases/HEAV3NS-CODE-latest.${EXT}" \
        --remote --file "$WORK/HEAV3NS-CODE-macOS-arm64.${EXT}" --content-type application/octet-stream --cache-control 'no-cache, max-age=0, must-revalidate'
done
"$WRANGLER" r2 object put heav3ns-releases/SHA256SUMS.txt --remote --file "$WORK/SHA256SUMS.txt" --content-type text/plain --cache-control 'no-cache, max-age=0'
# Publish metadata after complete mirror files, then activate the legacy native feed last.
"$WRANGLER" r2 object put heav3ns-releases/latest.json --remote --file "$WORK/latest.json" --content-type application/json --cache-control 'no-cache, max-age=0'
"$WRANGLER" r2 object put heav3ns-releases/appcast.xml --remote --file "$WORK/appcast-arm64.xml" --content-type application/xml --cache-control 'no-cache, max-age=0'
echo "Updated compatible R2 aliases, website metadata, and legacy native feed for $TAG."
