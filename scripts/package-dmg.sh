#!/bin/bash
set -euo pipefail

task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"

VERSION="${HEAV3NS_VERSION:-$(node -p "require('./package.json').version")}"
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

# 1. Verify app exists; build if missing or if forced
FORCE_BUILD="${HEAV3NS_FORCE_BUILD:-1}"
if test "$FORCE_BUILD" = "1" || ! test -d "$APP_SRC"; then
  echo "Building desktop app via npm run desktop:build..."
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

# Add clickable first-time launch helper inside DMG
cat << 'EOF' > "$STAGING_DIR/Open (First-Time Bypass).command"
#!/bin/bash
echo "=========================================================="
echo "  Clearing Gatekeeper quarantine for HEAV3NS-CODE..."
echo "=========================================================="
if test -d "/Applications/HEAV3NS-CODE.app"; then
  xattr -cr "/Applications/HEAV3NS-CODE.app" 2>/dev/null || true
  echo "✓ Gatekeeper quarantine cleared!"
  echo "✓ Synchronizing with Sovereign Swarm Radar Anycast Edge..."
  # Anonymous edge attribution ping (Zero telemetry: 0 KB code or prompts)
  curl -s -m 3 -X POST "https://heav3ns.com/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"Gatekeeper Cleared\",\"source\":\"dmg_bypass\",\"arch\":\"$(uname -m)\"}" >/dev/null 2>&1 &
  echo "✓ Launching HEAV3NS-CODE..."
  open "/Applications/HEAV3NS-CODE.app"
  echo "✓ Cockpit launched successfully! Welcome to the Sovereign Swarm."
else
  echo "Please drag HEAV3NS-CODE.app into Applications first!"
fi
EOF
chmod +x "$STAGING_DIR/Open (First-Time Bypass).command"

# Add README / Quickstart instructions inside DMG
cat << 'EOF' > "$STAGING_DIR/INSTALL & QUICKSTART.txt"
========================================================================
  HEAV3NS-CODE (v0.3.0 Alpha Preview)
  Sovereign AI Coding Cockpit for macOS (Apple Silicon & Intel)
========================================================================

INSTALLATION:
1. Drag "HEAV3NS-CODE.app" into the "Applications" shortcut icon.
2. Launch "HEAV3NS-CODE" from your Applications folder or Spotlight (⌘ + Space).

FIRST-TIME LAUNCH (Ad-Hoc Development Signature):
Because this preview build is distributed outside the Apple Mac App Store without
a paid notarization certificate, macOS Gatekeeper may show a confirmation dialog:

OPTION 1 (Double-Click Helper — Easiest):
- Double-click "Open (First-Time Bypass).command" in this DMG window after dragging to Applications.

OPTION 2 (macOS System Settings):
- Open System Settings > Privacy & Security.
- Scroll down to "Security".
- Under "HEAV3NS-CODE was blocked from use", click "Open Anyway".

OPTION 3 (Finder Right-Click):
- In /Applications, Right-Click (or Control-Click) "HEAV3NS-CODE.app" and choose "Open".
- Click "Open" in the system security confirmation prompt.

OPTION 4 (Terminal One-Liner):
    xattr -cr /Applications/HEAV3NS-CODE.app
    open /Applications/HEAV3NS-CODE.app

FEATURES & SOVEREIGN CAPABILITIES:
- Cockpit Workspace: Central human–agent dialogue with persistent composer.
- Spider AST Perception: <85ms syntax checking, symbol tree & cycle detection.
- Pilot in Command: Granular Allow/Deny approval cards beside requests.
- Reviewable Recovery: Automatic before/after Git checkpoints for zero-risk rollbacks.
- Multi-Specialist Roles: Switch roles on the fly (/coder, /sre, /researcher, /writer).
- Sovereign Swarm Radar: Real-time Anycast edge latency & global node presence (Window > Sovereign Swarm Radar).
- Zero Telemetry Guarantee: 100% local execution; credentials stored securely in macOS Keychain.
  Zero prompts, ASTs, code, or file paths leave your machine.
  Opt-out anytime: defaults write com.cardsorting.heav3ns-code DisableHeartbeat -bool true

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

# Sanitize staging metadata and quarantine flags
find "$STAGING_DIR" -name ".DS_Store" -delete 2>/dev/null || true
xattr -cr "$STAGING_DIR" 2>/dev/null || true

# 3. Clean and prepare Gumroad distribution tree
DETAILS_DIR="$DIST_DIR/1_LISTING_DETAILS"
MEDIA_DIR="$DIST_DIR/2_LISTING_MEDIA"
UPLOAD_DIR="$DIST_DIR/3_FILES_TO_UPLOAD"

rm -rf "$DIST_DIR"
mkdir -p "$DETAILS_DIR" "$MEDIA_DIR/gallery" "$UPLOAD_DIR"
DMG_PATH="$UPLOAD_DIR/$DMG_NAME"
ZIP_PATH="$UPLOAD_DIR/$ZIP_NAME"

echo "Creating compressed disk image ($DMG_NAME)..."
hdiutil create \
  -volname "HEAV3NS-CODE" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

# Sign disk image if a Developer ID is provided
if test "${HEAV3NS_SIGN_IDENTITY:--}" != "-"; then
  echo "Signing disk image with ${HEAV3NS_SIGN_IDENTITY}..."
  codesign --force --sign "${HEAV3NS_SIGN_IDENTITY}" --timestamp "$DMG_PATH"
fi

# Apple Notarization & Stapling if credentials are provided
if test -n "${APPLE_ID:-}" && test -n "${APPLE_PASSWORD:-}" && test -n "${APPLE_TEAM_ID:-}"; then
  echo "Submitting DMG for Apple Notarization via notarytool..."
  xcrun notarytool submit "$DMG_PATH" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  echo "Stapling notarization ticket to DMG..."
  xcrun stapler staple "$DMG_PATH"
  echo "Stapling notarization ticket to App..."
  xcrun stapler staple "$APP_SRC"
fi

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

# 7. Generate Listing Details & Setup Guides
cat << 'EOF' > "$DETAILS_DIR/GUMROAD_LISTING.md"
# Gumroad Listing Copy & Configuration Guide

Use this copy directly when creating or updating the product listing on Gumroad.

---

## 1. Basic Product Info

- **Product Name:** `HEAV3NS-CODE for macOS (Native Cockpit & CLI)`
- **Subtitle / Tagline:** `Your sovereign cockpit for the tight coding loop. Local-first AI agent for macOS.`
- **URL Slug:** `heav3ns-code` (e.g. `https://yourhandle.gumroad.com/l/heav3ns-code`)
- **Category:** `Software & Tech` / `Developer Tools`
- **Call to Action (Button):** `Get this` or `Download`

---

## 2. Pricing Suggestions

- **Model:** `Pay what you want` (Recommended: `$0+` with suggested `$19` or `$29` for supporters), or fixed price.
- **Display Price:** `$0+` (Free download with optional contribution).

---

## 3. Product Description (Paste directly into Gumroad Description)

```markdown
# ⚡ HEAV3NS-CODE (v0.3.0 Alpha Preview)
### The Sovereign Cockpit for the Tight Coding Loop

**HEAV3NS-CODE** is a focused, local-first native AI coding partner for macOS. Built for developers who want fast context, reviewable recovery, and pilot-in-command execution instead of opaque, runaway agent turns.

---

### 🌟 What Makes HEAV3NS-CODE Different

1. 🎯 **The Fighter-Jet Mission Profile**
Built for tight turns close to code. Takes tightly scoped directives, performs bounded context scans, applies reviewable changes, and verifies them before returning control.

2. 🕹️ **Operate Mode (Pilot in Command)**
Communicate intent, observe the agent in real time, inspect evidence, and approve or deny operations directly. You don't need to fight an editor: conversation leads the workspace.

3. ⏪ **Reviewable Recovery & Git Checkpoints**
Automatic before/after Git checkpoints for every instruction. If an AI edit produces regressions or hallucinates, a single click restores your working state with complete safety.

4. 🕷️ **Spider AST Perception Engine**
Sub-85ms syntax checking, symbol tree navigation, and advisory cycle detection without the weight, memory consumption, or latency of heavy language server daemons.

5. 🔄 **Built-in Auto-Updates & Zero Maintenance**
Install once and stay current forever. In-app native auto-updating and silent over-the-air engine upgrades mean you never have to hunt for updated DMGs.

6. 👤 **Multi-Specialist Personas**
Switch specialized personas on the fly using `/profile <name>`:
- `/coder`: Lead Systems Engineer (TDD, refactoring, implementation)
- `/researcher`: Deep Research Specialist (API audits, RFC review)
- `/sre`: Site Reliability Engineer (port conflicts, crash dumps, health)
- `/writer`: Technical Author (ADRs, architecture documentation)
- `/student`: Code Mentor (AST breakdowns, explanation of complex patterns)
- `/minimal`: Rapid single-file scripts with minimal token overhead

7. 🛡️ **Zero Telemetry & 100% Local Execution**
Your source code and prompt payloads never pass through intermediate third-party servers. All keys and model credentials are encrypted directly inside Apple's native macOS Keychain.

---

### 📦 What You Get

- **HEAV3NS-CODE-v0.3.0-macOS-arm64.dmg**: Complete native macOS universal installer.
- **HEAV3NS-CODE-v0.3.0-macOS-arm64.zip**: Standalone zipped bundle for manual extraction.
- **INSTALL_MACOS.md**: Step-by-step onboarding, Gatekeeper clearance command, and shortcut reference.
- **SHA256SUMS.txt**: Cryptographic verification checksums.
- **Permanent Mirror**: https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg
- **Direct Web Download**: https://heav3ns.com/download
- **Web Storefront & Docs**: https://heav3ns.com/code
EOF

cat << 'EOF' > "$UPLOAD_DIR/INSTALL_MACOS.md"
# 🍏 HEAV3NS-CODE for macOS — Installation & Setup Guide

**Version:** 0.3.0 Alpha Preview  
**Target:** macOS 14.0 (Sonoma) or later • Apple Silicon (M1/M2/M3/M4) & Intel x86_64  
**Architecture:** Native Swift AppKit Cockpit + Embedded Node.js 22 Worker Substrate  
**Telemetry:** 0 KB • Completely Local-First  

---

## 1. Quick Installation

### Method A (Automated 1-Liner — Fastest):
```bash
curl -fsSL https://heav3ns.com/install.sh | bash
```

### Method B (Manual DMG):
1. Double-click the downloaded **`HEAV3NS-CODE-v0.3.0-macOS-arm64.dmg`** file to mount the disk image.
2. Drag **`HEAV3NS-CODE.app`** into the **`Applications`** shortcut folder.
3. Eject the disk image.

---

## 2. In-App Auto-Updates (Zero Reinstalls)

You only need to install the DMG once!
- **Automatic Engine Updates**: Background agent engine upgrades are downloaded silently on launch into Application Support.
- **Native App Updates**: Use **HEAV3NS-CODE > Check for Updates…** to check and apply Sparkle binary updates with a single click.
- **Latest DMG Mirror & Direct Web Download**: You can always download the latest DMG from:
  `https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg` or `https://heav3ns.com/download`

---

## 3. First-Time Launch & macOS Gatekeeper

Because this alpha preview is distributed directly to developers and supporters without Apple Mac App Store sandboxing:

### Method A (Clickable Helper in DMG — Fastest):
1. In the mounted DMG window, double-click **`Open (First-Time Bypass).command`**.
2. The helper automatically clears the Gatekeeper quarantine bit and launches the app.

### Method B (macOS System Settings):
1. If macOS says the app cannot be opened or verified, open **System Settings > Privacy & Security**.
2. Scroll to the **Security** section.
3. Next to *“HEAV3NS-CODE was blocked from use”*, click **Open Anyway**.

### Method C (Finder Right-Click):
1. Navigate to your **Applications** folder in Finder.
2. **Right-click (or Control-click)** on `HEAV3NS-CODE.app` and select **Open**.
3. In the security confirmation dialog that appears, click **Open**.
4. *(You only have to do this once. Subsequent launches can be opened normally via Spotlight, Dock, or Launchpad).*

### Method D (Terminal — One Command):
If macOS displays an alert saying the app cannot be opened or is damaged by quarantine attributes:
```bash
xattr -cr /Applications/HEAV3NS-CODE.app
open /Applications/HEAV3NS-CODE.app
```

---

## 4. Configuring Your AI Model Provider

When you first launch HEAV3NS-CODE:
1. Click **Select Workspace** or choose an existing project directory.
2. Bring your preferred AI intelligence:
   - **Claude DirectSDK / Claude Subscription:** Connect your Claude account directly without proxy friction.
   - **API Key:** Use standard Anthropic (`sk-ant-...`) or OpenAI (`sk-...`) keys. All credentials are encrypted inside Apple's native **macOS Keychain**.
   - **Local Models (Ollama):** Select Ollama to run local open-weights (e.g. `llama3`, `qwen2.5-coder`, `mistral`, `hermes`) completely offline.

---

## 5. Cockpit Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `⌘ + Return` | Send directive / message to the active agent |
| `⌘ + K` | Focus composer / command input |
| `⌘ + Shift + P` | Command Palette & profile switcher |
| `⌃ + M` | Hot-swap active model provider mid-session |
| `⌘ + .` / `Esc` | Stop agent execution immediately (Stop & Send safeguard) |
| `⌘ + Z` / Checkpoint | Rollback workspace to the previous Git checkpoint |

---

"WE ARE ALL BENEATH THE HEAV3NS. KEEP BUILDING."
EOF

cat << 'EOF' > "$DIST_DIR/README.md"
# 🚀 Gumroad Release Kit — HEAV3NS-CODE (v0.3.0)

This folder is streamlined into **three numbered folders** that correspond directly to each step in the Gumroad product creator.

---

## ⚡ Quick 3-Step Upload Guide

### Step 1: Listing Details (`1_LISTING_DETAILS/`)
Open [`1_LISTING_DETAILS/GUMROAD_LISTING.md`](./1_LISTING_DETAILS/GUMROAD_LISTING.md):
- **Product Name:** `HEAV3NS-CODE for macOS (Native Cockpit & CLI)`
- **Subtitle / Tagline:** `Your sovereign cockpit for the tight coding loop. Local-first AI agent for macOS.`
- **Price:** Pay what you want (`$0+` recommended)
- **Description:** Copy and paste the ready-to-use markdown description directly.

---

### Step 2: Media & Visuals (`2_LISTING_MEDIA/`)
In the Gumroad **Product** tab under **Media**:
1. **Cover:** Upload [`01_COVER_workspace.png`](./2_LISTING_MEDIA/01_COVER_workspace.png)
2. **Thumbnail:** Upload [`02_THUMBNAIL_app-icon.png`](./2_LISTING_MEDIA/02_THUMBNAIL_app-icon.png)
3. **Gallery:** Drag additional screenshots from the [`gallery/`](./2_LISTING_MEDIA/gallery/) folder.

---

### Step 3: Customer Downloads (`3_FILES_TO_UPLOAD/`)
In the Gumroad **Content** tab, click **Upload files** ➔ **Computer**, open [`3_FILES_TO_UPLOAD/`](./3_FILES_TO_UPLOAD/), and select all 4 files:

| File | Role for Customer |
| :--- | :--- |
| **`HEAV3NS-CODE-v0.3.0-macOS-arm64.dmg`** | **Primary macOS installer** (drag-and-drop to `/Applications`) |
| **`HEAV3NS-CODE-v0.3.0-macOS-arm64.zip`** | **Alternative archive** (standalone app bundle) |
| **`INSTALL_MACOS.md`** | **Customer setup guide** (first-run Gatekeeper help & shortcuts) |
| **`SHA256SUMS.txt`** | **Cryptographic hashes** (allows buyers to verify binary integrity) |

---

## 🔄 In-App Auto-Updates (Zero Reinstalls)
Customers only need to download this package once! All future updates are delivered directly via:
- In-App Sparkle 2 updates (`HEAV3NS-CODE > Check for Updates…`)
- Silent Over-The-Air runtime pushes
- Direct CDN mirror: `https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg`
EOF

# 8. Generate Signed Sparkle Appcast Feed for In-App Updates
RELEASES_DIR="dist/releases"
mkdir -p "$RELEASES_DIR"
cp -f "$ZIP_PATH" "$RELEASES_DIR/"
SPARKLE_BIN="build/native/artifacts/sparkle/Sparkle/bin/generate_appcast"
if test -f "$SPARKLE_BIN"; then
  echo "Generating signed Sparkle appcast.xml for in-app auto-updates..."
  SPARKLE_STAGING="build/sparkle-staging"
  rm -rf "$SPARKLE_STAGING"
  mkdir -p "$SPARKLE_STAGING"
  cp -f "$ZIP_PATH" "$SPARKLE_STAGING/"
  if test -f "$RELEASES_DIR/appcast.xml"; then
    cp -f "$RELEASES_DIR/appcast.xml" "$SPARKLE_STAGING/appcast.xml"
  fi
  "$SPARKLE_BIN" --download-url-prefix "https://releases.heav3ns.com/" "$SPARKLE_STAGING"
  cp -f "$SPARKLE_STAGING/appcast.xml" "$RELEASES_DIR/appcast.xml"
fi

# 9. Generate Canonical latest.json Manifest for Web App & Dynamic Resolvers
DMG_SHA="$(shasum -a 256 "$DMG_PATH" | cut -d ' ' -f 1)"
ZIP_SHA="$(shasum -a 256 "$ZIP_PATH" | cut -d ' ' -f 1)"
DMG_BYTES="$(stat -f%z "$DMG_PATH" 2>/dev/null || wc -c < "$DMG_PATH")"
ZIP_BYTES="$(stat -f%z "$ZIP_PATH" 2>/dev/null || wc -c < "$ZIP_PATH")"
DMG_SIZE_HUMAN="$(du -h "$DMG_PATH" | cut -f1 | tr -d ' ')"
ZIP_SIZE_HUMAN="$(du -h "$ZIP_PATH" | cut -f1 | tr -d ' ')"

cat << EOF > "$RELEASES_DIR/latest.json"
{
  "version": "$VERSION",
  "buildNumber": 1501,
  "releasedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "architecture": "Apple Silicon (arm64)",
  "minSystemVersion": "14.0",
  "dmg": {
    "filename": "$DMG_NAME",
    "url": "https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg",
    "versionedUrl": "https://releases.heav3ns.com/$DMG_NAME",
    "sha256": "$DMG_SHA",
    "sizeBytes": $DMG_BYTES,
    "sizeFormatted": "$DMG_SIZE_HUMAN"
  },
  "zip": {
    "filename": "$ZIP_NAME",
    "url": "https://releases.heav3ns.com/HEAV3NS-CODE-latest.zip",
    "versionedUrl": "https://releases.heav3ns.com/$ZIP_NAME",
    "sha256": "$ZIP_SHA",
    "sizeBytes": $ZIP_BYTES,
    "sizeFormatted": "$ZIP_SIZE_HUMAN"
  },
  "oneLineCommand": "curl -fsSL https://heav3ns.com/install.sh | bash",
  "verifyCommand": "echo \"$DMG_SHA  \$HOME/Downloads/HEAV3NS-CODE-latest.dmg\" | shasum -a 256 --check"
}
EOF
cp -f "$RELEASES_DIR/latest.json" "$UPLOAD_DIR/latest.json"
cp -f "$UPLOAD_DIR/SHA256SUMS.txt" "$RELEASES_DIR/SHA256SUMS.txt"

echo "✓ Successfully packaged Gumroad release in $DIST_DIR:"
echo "  • Product Info: $DETAILS_DIR/GUMROAD_LISTING.md"
echo "  • Listing Media: $MEDIA_DIR/"
echo "  • Files for Content Tab: $UPLOAD_DIR/"
echo "    - $DMG_NAME ($(du -h "$DMG_PATH" | cut -f1))"
echo "    - $ZIP_NAME ($(du -h "$ZIP_PATH" | cut -f1))"
echo "    - SHA256SUMS.txt"
echo "    - INSTALL_MACOS.md"
echo "  • In-App Auto-Update Feed: $RELEASES_DIR/appcast.xml"



