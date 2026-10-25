#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Publish HEAV3NS-CODE macOS releases from a Mac with GitHub CLI installed." >&2
    exit 1
fi
for tool in gh git shasum codesign spctl file ditto xcrun; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "Required release tool is missing: $tool" >&2
        exit 1
    }
done

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' native/Info.plist)"
TAG="v${VERSION#v}"
TAG_COMMIT="$(git rev-parse --verify "refs/tags/${TAG}^{commit}" 2>/dev/null || true)"
[[ -n "$TAG_COMMIT" ]] || {
    echo "The matching source tag ${TAG} is missing locally." >&2
    exit 1
}
[[ "$(git rev-parse HEAD)" == "$TAG_COMMIT" ]] || {
    echo "Check out ${TAG} before publishing its release assets." >&2
    exit 1
}
[[ -z "$(git status --porcelain)" ]] || {
    echo "The source tree has local changes. Commit or remove them before publishing." >&2
    exit 1
}
SOURCE_REPO="CardSorting/HEAV3NS-CODE"
DIST_REPO="CardSorting/HEAV3NS-CODE-Releases"
RELEASE_ROOT="$ROOT/build/release"
PUBLISH_LOCK="$RELEASE_ROOT/.${TAG}-publish.lock"
mkdir -p "$RELEASE_ROOT"
mkdir "$PUBLISH_LOCK" || {
    echo "A publisher may already be running: $PUBLISH_LOCK" >&2
    exit 1
}
STAGE=""
cleanup() {
    if [[ -n "$STAGE" && -d "$STAGE" ]]; then rm -rf "$STAGE"; fi
    if [[ -d "$PUBLISH_LOCK" ]]; then rmdir "$PUBLISH_LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_developer_id_signature() {
    local TARGET_PATH="$1"
    local DETAILS
    DETAILS="$(codesign --display --verbose=2 "$TARGET_PATH" 2>&1)" || {
        echo "Could not read the code signature for ${TARGET_PATH}." >&2
        exit 1
    }
    if [[ "$DETAILS" != *"Authority=Developer ID Application:"* \
        || "$DETAILS" != *"TeamIdentifier="* \
        || "$DETAILS" != *"Timestamp="* \
        || "$DETAILS" != *"(runtime)"* ]]; then
        echo "${TARGET_PATH} needs a timestamped Developer ID Application signature with hardened runtime." >&2
        exit 1
    fi
}

ARCHES=(arm64 x86_64)
ASSETS=()
for ARCH in "${ARCHES[@]}"; do
    SOURCE="$RELEASE_ROOT/${TAG}-${ARCH}"
    ZIP_NAME="HEAV3NS-CODE-macOS-${ARCH}.zip"
    DMG_NAME="HEAV3NS-CODE-macOS-${ARCH}.dmg"
    [[ -d "$SOURCE" && ! -L "$SOURCE" ]] || {
        echo "Missing ${ARCH} release assets at ${SOURCE}. Prepare both architectures before publishing." >&2
        exit 1
    }
    [[ -f "$SOURCE/$ZIP_NAME" && ! -L "$SOURCE/$ZIP_NAME" \
        && -f "$SOURCE/$DMG_NAME" && ! -L "$SOURCE/$DMG_NAME" \
        && -f "$SOURCE/SHA256SUMS.txt" && ! -L "$SOURCE/SHA256SUMS.txt" ]] || {
        echo "${SOURCE} is incomplete; it needs the ZIP, DMG, and SHA256SUMS.txt." >&2
        exit 1
    }
    (
        cd "$SOURCE"
        shasum -a 256 --check SHA256SUMS.txt
        for NAME in "$ZIP_NAME" "$DMG_NAME"; do
            COUNT="$(awk -v name="$NAME" '$2 == name { n++ } END { print n + 0 }' SHA256SUMS.txt)"
            [[ "$COUNT" == 1 ]] || {
                echo "SHA256SUMS.txt must contain exactly one entry for ${NAME}." >&2
                exit 1
            }
        done
        EXTRA="$(awk -v zip="$ZIP_NAME" -v dmg="$DMG_NAME" '$2 != zip && $2 != dmg { print $2 }' SHA256SUMS.txt)"
        [[ -z "$EXTRA" ]] || {
            echo "SHA256SUMS.txt contains unexpected entries: ${EXTRA}" >&2
            exit 1
        }
    )
    xcrun stapler validate "$SOURCE/$DMG_NAME"

    STAGE="$(mktemp -d "$RELEASE_ROOT/.${TAG}-publish.XXXXXX")"
    mkdir "$STAGE/${ARCH}-unpacked"
    ditto -x -k "$SOURCE/$ZIP_NAME" "$STAGE/${ARCH}-unpacked"
    APP="$STAGE/${ARCH}-unpacked/HEAV3NS-CODE.app"
    [[ -d "$APP" && ! -L "$APP" ]] || {
        echo "${ZIP_NAME} does not contain HEAV3NS-CODE.app at the archive root." >&2
        exit 1
    }
    codesign --verify --deep --strict "$APP"
    assert_developer_id_signature "$APP"
    codesign --verify --strict -R='anchor apple generic and identifier "io.heav3ns.code" and certificate leaf[subject.OU] = "C35F6CCNLU"' "$APP"
    spctl --assess --type execute "$APP"
    xcrun stapler validate "$APP"
    APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
    [[ "$APP_VERSION" == "$VERSION" ]] || {
        echo "${ZIP_NAME} contains ${APP_VERSION}, but the tagged release is ${VERSION}." >&2
        exit 1
    }
    ARCHIVE_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
    SOURCE_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' native/Info.plist)"
    [[ "$ARCHIVE_BUILD" == "$SOURCE_BUILD" ]] || { echo 'Archive build number mismatch.' >&2; exit 1; }
    FEED="$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$APP/Contents/Info.plist")"
    [[ "$FEED" == "https://raw.githubusercontent.com/${DIST_REPO}/main/appcast-${ARCH}.xml" ]] || {
        echo 'Archive update feed does not match its architecture.' >&2; exit 1;
    }
    [[ -d "$APP/Contents/Frameworks/Sparkle.framework" ]] || { echo 'Sparkle is missing.' >&2; exit 1; }
    codesign --verify --deep --strict "$APP/Contents/Frameworks/Sparkle.framework"
    for BINARY in "$APP/Contents/MacOS/HEAV3NS-CODE" "$APP/Contents/Resources/runtime/node"; do
        assert_developer_id_signature "$BINARY"
        DESCRIPTION="$(file -b "$BINARY" 2>/dev/null || true)"
        [[ "$DESCRIPTION" == *Mach-O* && "$DESCRIPTION" == *"$ARCH"* ]] || {
            echo "${BINARY##*/} in ${ZIP_NAME} is not a Mach-O binary for ${ARCH}." >&2
            exit 1
        }
    done
    rm -rf "$STAGE"
    STAGE=""
    ASSETS+=("$SOURCE/$ZIP_NAME" "$SOURCE/$DMG_NAME")
done

STAGE="$(mktemp -d "$RELEASE_ROOT/.${TAG}-publish.XXXXXX")"
PUBLISH_DIR="$STAGE/assets"
mkdir "$PUBLISH_DIR"
for ARCH in "${ARCHES[@]}"; do
    SOURCE="$RELEASE_ROOT/${TAG}-${ARCH}"
    cp "$SOURCE/HEAV3NS-CODE-macOS-${ARCH}.zip" "$PUBLISH_DIR/"
    cp "$SOURCE/HEAV3NS-CODE-macOS-${ARCH}.dmg" "$PUBLISH_DIR/"
done
cp scripts/macos/install.sh "$PUBLISH_DIR/install.sh"
ASSETS+=("$PUBLISH_DIR/install.sh")
(
    cd "$PUBLISH_DIR"
    shasum -a 256 \
        HEAV3NS-CODE-macOS-arm64.zip HEAV3NS-CODE-macOS-arm64.dmg \
        HEAV3NS-CODE-macOS-x86_64.zip HEAV3NS-CODE-macOS-x86_64.dmg install.sh > SHA256SUMS.txt
)

gh auth status >/dev/null
# Validate signed history and strictly increasing build metadata before publication.
# The final feed is regenerated from anonymously downloaded public archives afterward.
SPARKLE="$(bash scripts/macos/fetch_sparkle.sh)"
mkdir "$STAGE/feed-preflight"
for ARCH in "${ARCHES[@]}"; do
    FEED_PATH="$STAGE/feed-preflight/appcast-${ARCH}.xml"
    STATUS="$(curl --location --silent --show-error --retry 2 --proto '=https' --proto-redir '=https' \
        --output "$FEED_PATH" --write-out '%{http_code}' \
        "https://raw.githubusercontent.com/${DIST_REPO}/main/appcast-${ARCH}.xml")"
    if [[ "$STATUS" == 404 ]]; then rm -f "$FEED_PATH"
    elif [[ "$STATUS" != 200 ]]; then echo "Could not validate current update feed (${STATUS})." >&2; exit 1
    fi
done
python3 scripts/macos/generate_appcast.py "$PUBLISH_DIR" "$STAGE/feed-preflight" --sparkle "$SPARKLE"
LOCAL_TAG_OBJECT="$(git rev-parse "refs/tags/${TAG}")"
REMOTE_TAG_OBJECT="$(gh api "repos/${SOURCE_REPO}/git/ref/tags/${TAG}" --jq .object.sha)"
[[ "$REMOTE_TAG_OBJECT" == "$LOCAL_TAG_OBJECT" ]] || {
    echo "Remote tag ${TAG} does not match the local release source; refusing to upload assets." >&2
    exit 1
}
if gh release view "$TAG" --repo "$DIST_REPO" >/dev/null 2>&1; then
    IS_DRAFT="$(gh release view "$TAG" --repo "$DIST_REPO" --json isDraft --jq .isDraft)"
    [[ "$IS_DRAFT" == true ]] || {
        echo "Release ${TAG} is already public. Publish a new app version instead of replacing it." >&2
        exit 1
    }
    gh release edit "$TAG" --repo "$DIST_REPO" --notes-file "docs/desktop/release-${VERSION}.md"
    gh release upload "$TAG" --repo "$DIST_REPO" "${ASSETS[@]}" --clobber
else
    gh release create "$TAG" --repo "$DIST_REPO" "${ASSETS[@]}" --verify-tag --draft \
        --title "HEAV3NS-CODE ${TAG}" --notes-file "docs/desktop/release-${VERSION}.md"
fi

# Upload the manifest last; installer and page clients can now verify every archive.
gh release upload "$TAG" --repo "$DIST_REPO" "$PUBLISH_DIR/SHA256SUMS.txt" --clobber

REMOTE_ASSETS="$(gh release view "$TAG" --repo "$DIST_REPO" --json assets --jq '.assets[].name')"
for NAME in \
    HEAV3NS-CODE-macOS-arm64.zip HEAV3NS-CODE-macOS-arm64.dmg \
    HEAV3NS-CODE-macOS-x86_64.zip HEAV3NS-CODE-macOS-x86_64.dmg install.sh SHA256SUMS.txt; do
    printf '%s\n' "$REMOTE_ASSETS" | grep -Fxq "$NAME" || {
        echo "GitHub release is missing ${NAME}; it remains a draft for safe retry." >&2
        exit 1
    }
done
gh release edit "$TAG" --repo "$DIST_REPO" --draft=false --latest
[[ "$(gh release view "$TAG" --repo "$DIST_REPO" --json isDraft --jq .isDraft)" == false ]] || {
    echo "GitHub did not confirm that ${TAG} was published; inspect the release before retrying." >&2
    exit 1
}

echo "Published ${TAG} with arm64 and x86_64 DMG, ZIP, and checksum assets."
echo "HEAV3NS-CODE's download page and macOS installer will discover this stable release."
bash scripts/macos/publish_update_feed.sh

bash scripts/macos/publish_legacy_mirror.sh
