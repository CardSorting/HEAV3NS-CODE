#!/bin/bash
set -euo pipefail

task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"

VERSION="0.1.0"
ARCH="$(uname -m)"
APP_SRC="build/HEAV3NS-CODE.app"
DIST_DIR="dist/gumroad"
STAGING_DIR="build/dmg-staging"
DMG_NAME="HEAV3NS-CODE-v${VERSION}-macOS-${ARCH}.dmg"
ZIP_NAME="HEAV3NS-CODE-v${VERSION}-macOS-${ARCH}.zip"

echo "=========================================================="
echo "  Packaging HEAV3NS-CODE v${VERSION} for macOS ($ARCH)"
echo "  Target Output: $DIST_DIR/$DMG_NAME"
echo "=========================================================="

# 1. Verify app exists; build if missing
if ! test -d "$APP_SRC"; then
  echo "Building desktop app first via npm run desktop:build..."
  npm run desktop:build
fi

# Verify codesign
echo "Verifying code signature on $APP_SRC..."
codesign --verify --deep --strict "$APP_SRC"

# 2. Prepare clean staging directory
echo "Preparing DMG staging area in $STAGING_DIR..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Copy .app preserving bundle metadata and symlinks
echo "Copying application bundle..."
ditto "$APP_SRC" "$STAGING_DIR/HEAV3NS-CODE.app"

# Create /Applications symlink for easy drag-to-install
echo "Creating Applications shortcut..."
ln -s /Applications "$STAGING_DIR/Applications"

# Add README / Quickstart instructions inside DMG
cat << 'EOF' > "$STAGING_DIR/INSTALL & QUICKSTART.txt"
========================================================================
  HEAV3NS-CODE (v0.1.0 Alpha Preview)
  Sovereign AI Coding Cockpit for macOS (Apple Silicon & Intel)
========================================================================

INSTALLATION:
1. Drag "HEAV3NS-CODE.app" into the "Applications" shortcut icon.
2. Launch "HEAV3NS-CODE" from your Applications folder or Spotlight (⌘ + Space).

FIRST-TIME LAUNCH (Ad-Hoc Development Signature):
Because this build is distributed outside the Apple Mac App Store without
a paid notarization cert, macOS Gatekeeper may ask for confirmation on first open:
- Right-click (or Control-click) "HEAV3NS-CODE.app" in Applications and choose "Open".
- Click "Open" in the system security confirmation prompt.
- OR run this single command in your Terminal:
    xattr -cr /Applications/HEAV3NS-CODE.app

FEATURES:
- Cockpit Workspace: Central human–agent dialogue with persistent composer.
- Spider AST Perception: <85ms syntax checking, symbol tree & cycle detection.
- Pilot in Command: Granular Allow/Deny approval cards beside requests.
- Reviewable Recovery: Automatic before/after Git checkpoints for zero-risk rollbacks.
- Multi-Specialist Roles: Switch roles on the fly (/coder, /sre, /researcher, /writer).
- Zero Telemetry: 100% local execution; credentials stored securely in macOS Keychain.

SYSTEM REQUIREMENTS:
- macOS 14.0 Sonoma or later
- Apple Silicon (M1/M2/M3/M4) or Intel x86_64
- Optional: Claude subscription, Anthropic / OpenAI API key, or local Ollama

"WE ARE ALL BENEATH THE HEAV3NS. KEEP BUILDING."
========================================================================
EOF

# Copy licenses into DMG
cp LICENSE "$STAGING_DIR/LICENSE.txt"
cp NOTICE "$STAGING_DIR/NOTICE.txt"

# 3. Create compressed DMG
DETAILS_DIR="$DIST_DIR/1_LISTING_DETAILS"
MEDIA_DIR="$DIST_DIR/2_LISTING_MEDIA"
UPLOAD_DIR="$DIST_DIR/3_FILES_TO_UPLOAD"

mkdir -p "$DETAILS_DIR" "$MEDIA_DIR/gallery" "$UPLOAD_DIR"
DMG_PATH="$UPLOAD_DIR/$DMG_NAME"
ZIP_PATH="$UPLOAD_DIR/$ZIP_NAME"

rm -f "$DMG_PATH"

echo "Creating compressed disk image ($DMG_NAME)..."
hdiutil create \
  -volname "HEAV3NS-CODE" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

# 4. Create standalone ZIP distribution
echo "Creating zip archive ($ZIP_NAME)..."
rm -f "$ZIP_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_SRC" "$ZIP_PATH"

# 5. Generate Checksums
echo "Generating SHA256 checksums..."
(
  cd "$UPLOAD_DIR"
  shasum -a 256 "$DMG_NAME" "$ZIP_NAME" > SHA256SUMS.txt
)

# 6. Copy visual assets if present in sibling repo
IMG_SRC="$task_root/../HEAV3NS/public/images/code"
if test -d "$IMG_SRC"; then
  mkdir -p "$MEDIA_DIR/gallery"
  test -f "$IMG_SRC/01-workspace.png" && cp -f "$IMG_SRC/01-workspace.png" "$MEDIA_DIR/01_COVER_workspace.png"
  test -f "$IMG_SRC/app-icon.png" && cp -f "$IMG_SRC/app-icon.png" "$MEDIA_DIR/02_THUMBNAIL_app-icon.png"
  test -f "$IMG_SRC/02-symbols.png" && cp -f "$IMG_SRC/02-symbols.png" "$MEDIA_DIR/gallery/03_symbols.png"
  test -f "$IMG_SRC/03-approval.png" && cp -f "$IMG_SRC/03-approval.png" "$MEDIA_DIR/gallery/04_approval.png"
  test -f "$IMG_SRC/04-working.png" && cp -f "$IMG_SRC/04-working.png" "$MEDIA_DIR/gallery/05_working.png"
  test -f "$IMG_SRC/05-changes.png" && cp -f "$IMG_SRC/05-changes.png" "$MEDIA_DIR/gallery/06_changes.png"
  test -f "$IMG_SRC/06-projects.png" && cp -f "$IMG_SRC/06-projects.png" "$MEDIA_DIR/gallery/07_projects.png"
  test -f "$IMG_SRC/07-welcome.png" && cp -f "$IMG_SRC/07-welcome.png" "$MEDIA_DIR/gallery/08_welcome.png"
fi

# 7. Generate Signed Sparkle Appcast Feed for In-App Updates
RELEASES_DIR="dist/releases"
mkdir -p "$RELEASES_DIR"
cp -f "$ZIP_PATH" "$RELEASES_DIR/"
SPARKLE_BIN="build/native/artifacts/sparkle/Sparkle/bin/generate_appcast"
if test -f "$SPARKLE_BIN"; then
  echo "Generating signed Sparkle appcast.xml for in-app auto-updates..."
  "$SPARKLE_BIN" --download-url-prefix "https://releases.heav3ns.com/" "$RELEASES_DIR"
fi

echo "✓ Successfully packaged Gumroad release in $DIST_DIR:"
echo "  • Product Info: $DETAILS_DIR/GUMROAD_LISTING.md"
echo "  • Listing Media: $MEDIA_DIR/"
echo "  • Files for Content Tab: $UPLOAD_DIR/"
echo "    - $DMG_NAME ($(du -h "$DMG_PATH" | cut -f1))"
echo "    - $ZIP_NAME ($(du -h "$ZIP_PATH" | cut -f1))"
echo "    - SHA256SUMS.txt"
echo "    - INSTALL_MACOS.md"
echo "  • In-App Auto-Update Feed: $RELEASES_DIR/appcast.xml"


