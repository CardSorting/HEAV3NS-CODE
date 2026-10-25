#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' native/Info.plist)"
TAG="v${VERSION#v}"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "refs/tags/${TAG}^{commit}")" \
    && -z "$(git status --porcelain)" ]] || {
    echo 'Publish feeds from the clean matching source tag.' >&2; exit 1;
}
REPO=CardSorting/HEAV3NS-CODE-Releases
SPARKLE="$(bash scripts/macos/fetch_sparkle.sh)"
WORK="$(mktemp -d "$ROOT/build/.nova-feed.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
IS_DRAFT="$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)"
[[ "$IS_DRAFT" == false ]] || { echo 'Release must be public before updating the feed.' >&2; exit 1; }
mkdir "$WORK/archives"
# Read anonymously from the same public URLs used by end-user apps.
for NAME in HEAV3NS-CODE-macOS-arm64.zip HEAV3NS-CODE-macOS-x86_64.zip HEAV3NS-CODE-macOS-arm64.dmg HEAV3NS-CODE-macOS-x86_64.dmg install.sh SHA256SUMS.txt; do
    curl --fail --location --silent --show-error --retry 2 --proto '=https' --proto-redir '=https' \
        "https://github.com/$REPO/releases/download/$TAG/$NAME" --output "$WORK/archives/$NAME"
done
(
    cd "$WORK/archives"
    shasum -a 256 --check SHA256SUMS.txt
)
for ARCH in arm64 x86_64; do
    LOCAL="$ROOT/build/release/${TAG}-${ARCH}/HEAV3NS-CODE-macOS-${ARCH}.zip"
    cmp "$LOCAL" "$WORK/archives/HEAV3NS-CODE-macOS-${ARCH}.zip"
done
gh repo clone "$REPO" "$WORK/distribution" -- --quiet
python3 scripts/macos/generate_appcast.py "$WORK/archives" "$WORK/distribution" --sparkle "$SPARKLE"
cp docs/desktop/DISTRIBUTION.md "$WORK/distribution/UPDATES.md"
(
    cd "$WORK/distribution"
    git add appcast-arm64.xml appcast-x86_64.xml UPDATES.md
    if ! git diff --cached --quiet; then
        git commit -m "Publish signed HEAV3NS-CODE ${TAG} update feeds"
        git push origin main
    fi
)
echo "Published signed architecture-specific update feeds for ${TAG}."
