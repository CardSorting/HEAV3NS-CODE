#!/bin/bash
set -euo pipefail

task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"

VERSION="$(node -p "require('./package.json').version")"
OUTPUT_DIR="dist/releases"
mkdir -p "$OUTPUT_DIR"

echo "=========================================================="
echo "  Publishing OTA Engine Hot-Update v${VERSION}"
echo "=========================================================="

echo "Building engine bundle..."
npm run build

TMP_TARBALL="$OUTPUT_DIR/engine-tmp.tar.gz"
echo "Packaging dist/ into $TMP_TARBALL..."
cp package.json dist/package.json
tar --exclude="dist/gumroad" --exclude="dist/releases" --exclude="*.map" -czf "$TMP_TARBALL" dist/

CHECKSUM="$(shasum -a 256 "$TMP_TARBALL" | cut -d ' ' -f 1)"
SHORT_HASH="$(echo "$CHECKSUM" | cut -c1-8)"
TARBALL_NAME="engine-v${VERSION}-${SHORT_HASH}.tar.gz"
TARBALL_PATH="$OUTPUT_DIR/$TARBALL_NAME"
mv "$TMP_TARBALL" "$TARBALL_PATH"
cp "$TARBALL_PATH" "$OUTPUT_DIR/engine-v${VERSION}.tar.gz"

cat << EOF > "$OUTPUT_DIR/engine-latest.json"
{
  "version": "$VERSION",
  "bundleUrl": "https://releases.heav3ns.com/$TARBALL_NAME",
  "sha256": "$CHECKSUM",
  "releasedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "✓ Created OTA hot-engine release in $OUTPUT_DIR:"
echo "  • Archive: $TARBALL_NAME ($(du -h "$TARBALL_PATH" | cut -f1))"
echo "  • Checksum: $CHECKSUM"
echo "  • Manifest: $OUTPUT_DIR/engine-latest.json"

if test "${1:-}" = "--upload" || test "${UPLOAD_TO_R2:-}" = "true"; then
  echo "Uploading to Cloudflare R2 (heav3ns-releases)..."
  npx wrangler r2 object put heav3ns-releases/"$TARBALL_NAME" --file="$TARBALL_PATH" --content-type="application/gzip" --remote
  npx wrangler r2 object put heav3ns-releases/engine-latest.json --file="$OUTPUT_DIR/engine-latest.json" --content-type="application/json" --remote
  echo "✓ Successfully deployed to https://releases.heav3ns.com/engine-latest.json"
  curl -s -m 3 -X POST "https://heav3ns.com/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"OTA Engine Deployed\",\"source\":\"ota_publisher\",\"v\":\"$VERSION\",\"arch\":\"arm64\"}" >/dev/null 2>&1 || true
else
  echo ""
  echo "To publish live to Cloudflare R2, run:"
  echo "  npm run publish:ota -- --upload"
fi

