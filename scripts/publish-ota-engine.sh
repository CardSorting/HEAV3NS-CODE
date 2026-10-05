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

TARBALL_NAME="engine-v${VERSION}.tar.gz"
TARBALL_PATH="$OUTPUT_DIR/$TARBALL_NAME"

echo "Packaging dist/ into $TARBALL_PATH..."
tar --exclude="dist/gumroad" --exclude="dist/releases" --exclude="*.map" -czf "$TARBALL_PATH" dist/

CHECKSUM="$(shasum -a 256 "$TARBALL_PATH" | cut -d ' ' -f 1)"

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
else
  echo ""
  echo "To publish live to Cloudflare R2, run:"
  echo "  npm run publish:ota -- --upload"
fi

