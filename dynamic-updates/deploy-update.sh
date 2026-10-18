#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
task_root="$(cd "$script_dir/.." && pwd)"
cd "$task_root"

ACTION="${1:-help}"
BUCKET="heav3ns-releases"
BASE_URL="https://releases.heav3ns.com"

color_green="\033[0;32m"
color_cyan="\033[0;36m"
color_yellow="\033[0;33m"
color_red="\033[0;31m"
color_reset="\033[0m"

log_info() { echo -e "${color_cyan}ℹ [UPDATE]${color_reset} $1"; }
log_ok() { echo -e "${color_green}✓ [UPDATE]${color_reset} $1"; }
log_warn() { echo -e "${color_yellow}⚠ [UPDATE]${color_reset} $1"; }
log_err() { echo -e "${color_red}✖ [UPDATE]${color_reset} $1"; }

case "$ACTION" in
  status)
    echo "=========================================================="
    echo "  HEAV3NS-CODE Remote Update Infrastructure Status"
    echo "  Target CDN: $BASE_URL"
    echo "=========================================================="
    echo ""

    check_endpoint() {
      local name="$1"
      local url="$2"
      local expected_type="$3"
      local response
      response="$(curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}" "$url" || echo "FAIL")"
      local code="$(echo "$response" | awk '{print $1}')"
      local type="$(echo "$response" | awk '{print $2}')"

      if [ "$code" = "200" ]; then
        log_ok "$name: HTTP $code ($type) - $url"
      else
        log_err "$name: HTTP $code - $url"
      fi
    }

    log_info "Probing live Cloudflare release endpoints..."
    check_endpoint "Sparkle Appcast Feed" "$BASE_URL/appcast.xml" "application/xml"
    check_endpoint "OTA Engine Manifest" "$BASE_URL/engine-latest.json" "application/json"
    check_endpoint "OTA 7MB Engine Tarball" "$BASE_URL/engine-v14.0.0.tar.gz" "application/gzip"
    check_endpoint "Sparkle Release Archive" "$BASE_URL/HEAV3NS-CODE-v0.3.0-macOS-arm64.zip" "application/zip"
    check_endpoint "Permanent DMG Download" "$BASE_URL/HEAV3NS-CODE-latest.dmg" "application/x-apple-diskimage"
    check_endpoint "Permanent ZIP Download" "$BASE_URL/HEAV3NS-CODE-latest.zip" "application/zip"
    echo ""
    log_info "Local Sparkle EdDSA Public Key:"
    echo "  SUPublicEDKey: GOOutbIDL5kYZ9sNS726PQkfEUOtMlcWZ2ORLjX3Hb0="
    ;;

  engine|ota)
    echo "=========================================================="
    echo "  Publishing Hot OTA Engine Update"
    echo "=========================================================="
    npm run publish:ota -- --upload
    log_ok "Hot OTA Engine successfully pushed to $BASE_URL/engine-latest.json"
    ;;

  native|dmg)
    echo "=========================================================="
    echo "  Publishing Native App & Sparkle Update"
    echo "=========================================================="
    npm run package:dmg

    VERSION="${HEAV3NS_VERSION:-$(node -p "require('./package.json').version")}"
    ARCH="$(uname -m)"
    ZIP_NAME="HEAV3NS-CODE-v${VERSION}-macOS-${ARCH}.zip"
    DMG_NAME="HEAV3NS-CODE-v${VERSION}-macOS-${ARCH}.dmg"

    log_info "Uploading Sparkle release payload to Cloudflare R2..."
    npx wrangler r2 object put "$BUCKET/$ZIP_NAME" --file="dist/releases/$ZIP_NAME" --content-type="application/zip" --remote
    npx wrangler r2 object put "$BUCKET/appcast.xml" --file="dist/releases/appcast.xml" --content-type="application/xml" --remote
    npx wrangler r2 object put "$BUCKET/$DMG_NAME" --file="dist/gumroad/3_FILES_TO_UPLOAD/$DMG_NAME" --content-type="application/x-apple-diskimage" --remote
    npx wrangler r2 object put "$BUCKET/HEAV3NS-CODE-latest.dmg" --file="dist/gumroad/3_FILES_TO_UPLOAD/$DMG_NAME" --content-type="application/x-apple-diskimage" --remote
    npx wrangler r2 object put "$BUCKET/HEAV3NS-CODE-latest.zip" --file="dist/releases/$ZIP_NAME" --content-type="application/zip" --remote
    npx wrangler r2 object put "$BUCKET/latest.json" --file="dist/releases/latest.json" --content-type="application/json" --remote
    npx wrangler r2 object put "$BUCKET/SHA256SUMS.txt" --file="dist/releases/SHA256SUMS.txt" --content-type="text/plain; charset=utf-8" --remote

    log_ok "Native app update, latest.json manifest, and signed Sparkle feed published to $BASE_URL/appcast.xml"
    ;;

  *)
    echo "Usage: ./dynamic-updates/deploy-update.sh <command>"
    echo ""
    echo "Commands:"
    echo "  status   - Test live health of all Cloudflare R2 update endpoints"
    echo "  engine   - Build, package, and deploy a hot OTA engine update (~7MB)"
    echo "  native   - Build, package, sign Sparkle appcast, and deploy DMG/ZIP"
    echo ""
    exit 1
    ;;
esac
