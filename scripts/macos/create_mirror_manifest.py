#!/usr/bin/env python3
"""Create compatible website metadata from final public release files."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import plistlib
import sys
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
work = Path(sys.argv[1])
info = plistlib.loads((root / 'native/Info.plist').read_bytes())
version = info['CFBundleShortVersionString']
build = int(info['CFBundleVersion'])
prefix = f'https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/download/v{version}'
ns = '{http://www.andymatuschak.org/xml-namespaces/sparkle}'
for arch in ['arm64', 'x86_64']:
    item = ET.parse(work / f'appcast-{arch}.xml').getroot().find('channel/item')
    if item.findtext(ns + 'version') != str(build) or item.findtext(ns + 'shortVersionString') != version:
        raise ValueError('The current public feed no longer matches this release; refusing to roll back mirrors')

def asset(arch, suffix):
    name = f'HEAV3NS-CODE-macOS-{arch}.{suffix}'
    file = work / name
    return dict(filename=name, url=f'{prefix}/{name}', versionedUrl=f'{prefix}/{name}',
                sha256=hashlib.sha256(file.read_bytes()).hexdigest(), sizeBytes=file.stat().st_size,
                sizeFormatted=f'{file.stat().st_size / 1024 / 1024:.0f}M')

arm = {kind: asset('arm64', kind) for kind in ['dmg', 'zip']}
manifest = dict(version=version, buildNumber=build, releasedAt=datetime.now(timezone.utc).isoformat(),
                architecture='Apple Silicon (arm64)', minSystemVersion=info['LSMinimumSystemVersion'],
                notarized=True, signed=True, **arm,
                architectures={arch: {kind: asset(arch, kind) for kind in ['dmg', 'zip']} for arch in ['arm64', 'x86_64']},
                oneLineCommand=f"curl --proto '=https' --proto-redir '=https' -fsSL {prefix}/install.sh | bash -s -- v{version}",
                verifyCommand=f"printf '%s  %s\\n' '{arm['dmg']['sha256']}' \"$HOME/Downloads/{arm['dmg']['filename']}\" | shasum -a 256 --check")
(work / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
