#!/bin/bash
set -euo pipefail

REPO="CardSorting/HEAV3NS-CODE-Releases"
TEAM_ID="C35F6CCNLU"
BUNDLE_ID="io.heav3ns.code"
API_URL="https://api.github.com/repos/${REPO}/releases?per_page=100"
RELEASES_URL="https://github.com/${REPO}/releases"

fail() {
    printf 'HEAV3NS-CODE installer: %s\n' "$1" >&2
    exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "HEAV3NS-CODE for macOS can only be installed on a Mac."
REQUESTED_TAG=""
CHECK_ONLY=false
APP_PATH=""
while (( $# )); do
    case "$1" in
        --check) CHECK_ONLY=true ;;
        --app)
            (( $# >= 2 )) || fail "--app requires an absolute path to HEAV3NS-CODE.app."
            APP_PATH="$2"; shift ;;
        --help)
            printf 'Usage: bash install.sh [vX.Y.Z] [--check] [--app /path/to/HEAV3NS-CODE.app]\n'
            printf 'Without a version, selects the highest complete stable version. Never downgrades.\n'
            exit 0 ;;
        -*) fail "Unknown option: $1" ;;
        *) [[ -z "$REQUESTED_TAG" ]] || fail "Specify only one release tag."
           REQUESTED_TAG="$1" ;;
    esac
    shift
done
stable_version() {
    [[ "$1" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}
version_newer() {
    awk -v candidate="${1#v}" -v installed="${2#v}" 'BEGIN {
        split(candidate, a, "."); split(installed, b, ".");
        for (i = 1; i <= 3; i++) {
            if (a[i] + 0 > b[i] + 0) exit 0;
            if (a[i] + 0 < b[i] + 0) exit 1;
        }
        exit 1;
    }'
}
if [[ -n "$REQUESTED_TAG" ]]; then
    stable_version "$REQUESTED_TAG" || fail "Invalid stable release tag: ${REQUESTED_TAG}."
fi
if [[ -n "$APP_PATH" ]]; then
    [[ "$APP_PATH" == /*/HEAV3NS-CODE.app ]] || fail "--app must be an absolute path ending in /HEAV3NS-CODE.app."
else
    if [[ -d "$HOME/Applications/HEAV3NS-CODE.app" && -d /Applications/HEAV3NS-CODE.app ]]; then
        fail "Two HEAV3NS-CODE installations were found. Use --app to select which one to update."
    elif [[ -d /Applications/HEAV3NS-CODE.app ]]; then
        APP_PATH=/Applications/HEAV3NS-CODE.app
    else
        APP_PATH="$HOME/Applications/HEAV3NS-CODE.app"
    fi
fi
TARGET="$APP_PATH"
APP_DIR="${TARGET%/*}"
[[ ! -L "$APP_DIR" && ! -L "$TARGET" ]] || fail "The installation path is a symbolic link; it was left untouched."
if [[ -e "$TARGET" && ! -d "$TARGET" ]]; then
    fail "${TARGET} is not a regular app bundle."
fi
installed_version() {
    if [[ -d "$TARGET" ]]; then
        local identifier version
        identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
        [[ "$identifier" == "$BUNDLE_ID" ]] || fail "${TARGET} belongs to another app."
        version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
        stable_version "$version" || fail "The installed version is invalid; refusing to replace it."
        printf '%s' "$version"
    fi
}
INSTALLED_VERSION="$(installed_version)"
ARCH="$(uname -m)"
case "$ARCH" in
    arm64|x86_64) ;;
    *) fail "Unsupported Mac architecture: ${ARCH}." ;;
esac

for tool in curl plutil shasum ditto codesign pgrep file spctl sw_vers; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required macOS tool is missing: ${tool}."
done

SYSTEM_VERSION="$(sw_vers -productVersion)"
SYSTEM_MAJOR="${SYSTEM_VERSION%%.*}"
[[ "$SYSTEM_MAJOR" =~ ^[0-9]+$ ]] || fail "Could not read the installed macOS version."
(( SYSTEM_MAJOR >= 14 )) || fail "HEAV3NS-CODE requires macOS 14 or later; this Mac is running ${SYSTEM_VERSION}."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/heav3ns-code-install.XXXXXX")"
STAGED_APP=""
BACKUP=""
INSTALL_LOCK=""
cleanup() {
    if [[ -n "$BACKUP" && -d "$BACKUP" && -n "$TARGET" && ! -e "$TARGET" && ! -L "$TARGET" ]]; then
        if ! mv "$BACKUP" "$TARGET"; then
            printf 'HEAV3NS-CODE installer: could not restore the previous app; it remains at %s\n' "$BACKUP" >&2
        fi
    fi
    if [[ -n "$STAGED_APP" && ( -e "$STAGED_APP" || -L "$STAGED_APP" ) ]]; then
        rm -rf "$STAGED_APP"
    fi
    if [[ -n "$INSTALL_LOCK" ]]; then rmdir "$INSTALL_LOCK" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "$REQUESTED_TAG" ]]; then
    printf 'Checking HEAV3NS-CODE %s for %s…\n' "$REQUESTED_TAG" "$ARCH"
else
    printf 'Checking the latest HEAV3NS-CODE build for %s…\n' "$ARCH"
fi
curl --fail --location --silent --show-error --retry 2 \
    --connect-timeout 10 --max-time 40 \
    --proto '=https' --proto-redir '=https' \
    --header 'Accept: application/vnd.github+json' \
    "$API_URL" --output "$WORK/release.json" \
    || fail "Could not reach GitHub Releases. Check your connection and try again."

RELEASE_INDEX=0
RELEASE_INDEX_FOUND=""
ASSET_INDEX=""
ASSET_NAME="HEAV3NS-CODE-macOS-${ARCH}.zip"
TAG=""
while CURRENT_TAG="$(plutil -extract "${RELEASE_INDEX}.tag_name" raw -o - "$WORK/release.json" 2>/dev/null)"; do
    DRAFT="$(plutil -extract "${RELEASE_INDEX}.draft" raw -o - "$WORK/release.json" 2>/dev/null || echo true)"
    PRERELEASE="$(plutil -extract "${RELEASE_INDEX}.prerelease" raw -o - "$WORK/release.json" 2>/dev/null || echo true)"
    if [[ "$DRAFT" == false && "$PRERELEASE" == false ]] && stable_version "$CURRENT_TAG" \
        && [[ -z "$REQUESTED_TAG" || "$CURRENT_TAG" == "$REQUESTED_TAG" ]]; then
        INDEX=0
        CANDIDATE_ZIP=""
        CANDIDATE_SUM=""
        while plutil -extract "${RELEASE_INDEX}.assets.${INDEX}.name" raw -o - "$WORK/release.json" >/dev/null 2>&1; do
            CANDIDATE="$(plutil -extract "${RELEASE_INDEX}.assets.${INDEX}.name" raw -o - "$WORK/release.json")"
            if [[ "$CANDIDATE" == "$ASSET_NAME" ]]; then CANDIDATE_ZIP="$INDEX"; fi
            if [[ "$CANDIDATE" == SHA256SUMS.txt ]]; then CANDIDATE_SUM="$INDEX"; fi
            INDEX=$((INDEX + 1))
        done
        if [[ -n "$CANDIDATE_ZIP" && -n "$CANDIDATE_SUM" ]] \
            && { [[ -z "$TAG" ]] || version_newer "$CURRENT_TAG" "$TAG"; }; then
            TAG="$CURRENT_TAG"
            ASSET_INDEX="$CANDIDATE_ZIP"
            RELEASE_INDEX_FOUND="$RELEASE_INDEX"
        fi
    fi
    RELEASE_INDEX=$((RELEASE_INDEX + 1))
done
[[ -n "$TAG" && -n "$ASSET_INDEX" ]] \
    || fail "No stable ZIP for ${ARCH} was found${REQUESTED_TAG:+ in release ${REQUESTED_TAG}}. See ${RELEASES_URL}."

ASSET_URL="$(plutil -extract "${RELEASE_INDEX_FOUND}.assets.${ASSET_INDEX}.browser_download_url" raw -o - "$WORK/release.json")"
[[ "$ASSET_URL" == "https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}" ]] \
    || fail "GitHub returned an unexpected download URL."
if [[ -n "$INSTALLED_VERSION" ]] && ! version_newer "$TAG" "$INSTALLED_VERSION"; then
    printf 'HEAV3NS-CODE %s is already installed at %s; available version is %s. No downgrade or reinstall performed.\n' "$INSTALLED_VERSION" "$TARGET" "$TAG"
    exit 0
fi
if [[ "$CHECK_ONLY" == true ]]; then
    printf 'HEAV3NS-CODE %s is available for %s (installed: %s).\n%s\n' "$TAG" "$ARCH" "${INSTALLED_VERSION:-none}" "$ASSET_URL"
    exit 0
fi
CHECKSUM_URL="${ASSET_URL%/*}/SHA256SUMS.txt"
printf 'Downloading HEAV3NS-CODE %s for %s…\n' "$TAG" "$ARCH"
curl --fail --location --silent --show-error --retry 2 --connect-timeout 10 --max-time 600 \
    --proto '=https' --proto-redir '=https' "$ASSET_URL" --output "$WORK/$ASSET_NAME" \
    || fail "The HEAV3NS-CODE archive could not be downloaded. Try again or use ${RELEASES_URL}."
curl --fail --location --silent --show-error --retry 2 --connect-timeout 10 --max-time 40 \
    --proto '=https' --proto-redir '=https' "$CHECKSUM_URL" --output "$WORK/SHA256SUMS.txt" \
    || fail "This release has no downloadable checksum file. Do not install an unverified archive."

HASH_COUNT="$(awk -v name="$ASSET_NAME" '$2 == name { n++ } END { print n + 0 }' "$WORK/SHA256SUMS.txt")"
[[ "$HASH_COUNT" == 1 ]] || fail "The checksum file must contain exactly one entry for ${ASSET_NAME}."
EXPECTED_HASH="$(awk -v name="$ASSET_NAME" '$2 == name { print $1; exit }' "$WORK/SHA256SUMS.txt")"
[[ "$EXPECTED_HASH" =~ ^[[:xdigit:]]{64}$ ]] \
    || fail "The release checksum file has no valid SHA-256 entry for ${ASSET_NAME}."
printf '%s  %s\n' "$EXPECTED_HASH" "$WORK/$ASSET_NAME" | shasum -a 256 --check \
    || fail "SHA-256 verification failed. The archive has been left uninstalled."

mkdir "$WORK/unpacked"
ditto -x -k "$WORK/$ASSET_NAME" "$WORK/unpacked" \
    || fail "The downloaded ZIP could not be unpacked."
SOURCE_APP="$WORK/unpacked/HEAV3NS-CODE.app"
[[ -d "$SOURCE_APP" && ! -L "$SOURCE_APP" ]] || fail "The release ZIP does not contain a HEAV3NS-CODE.app bundle."
for EXECUTABLE in "$SOURCE_APP/Contents/MacOS/HEAV3NS-CODE" "$SOURCE_APP/Contents/Resources/runtime/node"; do
    [[ -f "$EXECUTABLE" ]] || fail "The release is missing a required executable: ${EXECUTABLE##*/}."
    ARCH_DESCRIPTION="$(file -b "$EXECUTABLE" 2>/dev/null || true)"
    [[ "$ARCH_DESCRIPTION" == *Mach-O* && "$ARCH_DESCRIPTION" == *"$ARCH"* ]] \
        || fail "${EXECUTABLE##*/} is not a Mach-O binary for ${ARCH}."
done
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)"
[[ "$APP_VERSION" == "${TAG#v}" ]] || fail "The archive version does not match ${TAG}."
SIGNING_REQUIREMENT="anchor apple generic and identifier \"${BUNDLE_ID}\" and certificate leaf[subject.OU] = \"${TEAM_ID}\""
codesign --verify --deep --strict -R="$SIGNING_REQUIREMENT" "$SOURCE_APP" \
    || fail "The HEAV3NS-CODE app signature could not be verified. The existing installation was not changed."
spctl --assess --type execute "$SOURCE_APP" \
    || fail "Gatekeeper did not accept this app. The existing installation was not changed."

if pgrep -x HEAV3NS-CODE >/dev/null 2>&1; then
    fail "Quit HEAV3NS-CODE before installing the update, then run this command again."
fi

mkdir -p "$APP_DIR"
[[ -w "$APP_DIR" ]] || fail "${APP_DIR} is not writable. Install the DMG manually or choose --app in your Applications folder."
LOCK_PATH="$APP_DIR/.HEAV3NS-CODE.update.lock"
mkdir "$LOCK_PATH" 2>/dev/null || fail "Another install may be in progress (${LOCK_PATH})."
INSTALL_LOCK="$LOCK_PATH"
# Recheck under the lock in case another installer finished during the download.
[[ ! -L "$TARGET" ]] || fail "The target became a symbolic link."
INSTALLED_VERSION="$(installed_version)"
if [[ -n "$INSTALLED_VERSION" ]] && ! version_newer "$TAG" "$INSTALLED_VERSION"; then
    printf 'HEAV3NS-CODE %s is already installed. No changes made.\n' "$INSTALLED_VERSION"
    exit 0
fi
if pgrep -x HEAV3NS-CODE >/dev/null 2>&1; then fail "Quit HEAV3NS-CODE before installing the update."; fi

STAGED_APP="$APP_DIR/.HEAV3NS-CODE.app.installing.$$"
[[ ! -e "$STAGED_APP" && ! -L "$STAGED_APP" ]] || fail "A staging path already exists: ${STAGED_APP}."
ditto "$SOURCE_APP" "$STAGED_APP" || fail "HEAV3NS-CODE could not be staged in ${APP_DIR}."
codesign --verify --deep --strict -R="$SIGNING_REQUIREMENT" "$STAGED_APP" || fail "The staged HEAV3NS-CODE app did not pass signature verification."

if [[ -d "$TARGET" ]]; then
    # Keep rollback data without registering another application in Finder or Launch Services.
    BACKUP="$APP_DIR/.HEAV3NS-CODE.rollback.$(date -u +%Y%m%dT%H%M%SZ).$$"
    [[ ! -e "$BACKUP" && ! -L "$BACKUP" ]] || fail "The rollback path already exists: ${BACKUP}."
    mv "$TARGET" "$BACKUP" || fail "The existing HEAV3NS-CODE app could not be moved safely."
fi
if ! mv "$STAGED_APP" "$TARGET"; then
    if [[ -n "$BACKUP" && -d "$BACKUP" ]]; then
        if ! mv "$BACKUP" "$TARGET"; then
            fail "Install failed. The previous HEAV3NS-CODE app remains available at ${BACKUP}."
        fi
    fi
    fail "Installation did not complete. The previous HEAV3NS-CODE app has been restored."
fi
STAGED_APP=""

printf '\nHEAV3NS-CODE %s is installed at %s\n' "$TAG" "$TARGET"
if [[ -n "$BACKUP" ]]; then printf 'Previous version kept at %s\n' "$BACKUP"; fi
printf 'Open it from your Applications folder when you are ready.\n'
