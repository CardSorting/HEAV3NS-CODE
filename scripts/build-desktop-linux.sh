#!/bin/bash
# The GTK shell has no compiled platform code: Linux bundles can be assembled on macOS.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
arch="${HEAV3NS_LINUX_ARCH:-$(uname -m)}"
case "$arch" in
  x86_64|amd64|x64) arch=x64; node_sha=c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744 ;;
  aarch64|arm64) arch=arm64; node_sha=25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be ;;
  *) echo "Unsupported Linux architecture: $arch" >&2; exit 1 ;;
esac
node_version=22.22.0
node_archive="node-v${node_version}-linux-${arch}"
archive="build/downloads/${node_archive}.tar.gz"
mkdir -p build/downloads
if ! test -f "$archive"; then
  curl --fail --location --silent --show-error "https://nodejs.org/dist/v${node_version}/${node_archive}.tar.gz" -o "${archive}.partial"
  mv "${archive}.partial" "$archive"
fi
if command -v sha256sum >/dev/null; then
  actual_sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
else
  actual_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
fi
test "$actual_sha" = "$node_sha" || { echo 'Bundled Node checksum mismatch.' >&2; exit 1; }
npm run build
stage="$(mktemp -d "$root/build/linux-stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/HEAV3NS-CODE-linux-${arch}"
mkdir -p "$bundle/runtime/node_modules" "$bundle/share/icons/hicolor/256x256/apps"
tar -xzf "$archive" -C "$stage"
cp "$stage/$node_archive/bin/node" "$bundle/runtime/node"
cp "$stage/$node_archive/LICENSE" "$bundle/NODE-LICENSE"
cp -R dist "$bundle/runtime/dist"
cp -R node_modules/typescript "$bundle/runtime/node_modules/typescript"
cp -R native/linux/heav3ns_code "$bundle/"
# Never distribute local Python bytecode or test data.
find "$bundle/heav3ns_code" -name __pycache__ -type d -exec rm -rf {} +
cp native/linux/heav3ns-code native/linux/install.py "$bundle/"
cp native/linux/io.heav3ns.Code.desktop "$bundle/"
cp native/Assets/AppIcon.iconset/icon_256x256.png "$bundle/share/icons/hicolor/256x256/apps/io.heav3ns.Code.png"
cp LICENSE NOTICE THIRD-PARTY-NOTICES.md LICENSE-MAP.md TRADEMARKS.md PATENT-NON-AGGRESSION-PLEDGE.md "$bundle/"
cp docs/desktop/LINUX.md "$bundle/README.md"
cp docs/desktop/LINUX-AUDIT.md "$bundle/LINUX-AUDIT.md"
chmod +x "$bundle/heav3ns-code" "$bundle/runtime/node"
# Python tarfile excludes macOS resource forks and extended attributes.
python3 - "$stage" "$arch" <<'PYTAR'
import sys, tarfile
from pathlib import Path
stage, arch = Path(sys.argv[1]), sys.argv[2]
name = f"HEAV3NS-CODE-linux-{arch}"
with tarfile.open(f"build/{name}.tar.gz", "w:gz") as archive:
    archive.add(stage / name, arcname=name, filter=lambda item: None if Path(item.name).name.startswith("._") else item)
PYTAR
echo "Built $root/build/HEAV3NS-CODE-linux-${arch}.tar.gz"
echo 'Linux requires Python 3, PyGObject, GTK 4 and Git. See docs/desktop/LINUX.md.'
