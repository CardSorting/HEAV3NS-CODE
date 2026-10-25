#!/usr/bin/env python3
"""Generate and Ed25519-sign per-architecture feeds from verified final archives."""
import argparse
import base64
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
import plistlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET

SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE_NS)
ROOT = Path(__file__).resolve().parents[2]
PUBLIC_KEY = "GOOutbIDL5kYZ9sNS726PQkfEUOtMlcWZ2ORLjX3Hb0="


def sparkle(name):
    return f"{{{SPARKLE_NS}}}{name}"


def make_feed(info, archive, signature, architecture, previous=None):
    version, build = info['CFBundleShortVersionString'], info['CFBundleVersion']
    if not str(build).isdigit() or int(build) < 1:
        raise ValueError('CFBundleVersion must be a positive, increasing integer')
    if architecture not in ('arm64', 'x86_64'):
        raise ValueError('Unsupported architecture')
    if info.get('SUPublicEDKey') != PUBLIC_KEY or not info.get('SURequireSignedFeed') \
            or not info.get('SUVerifyUpdateBeforeExtraction'):
        raise ValueError('The archived app must require the configured Ed25519 key and signed feeds')
    expected_feed = f'https://raw.githubusercontent.com/CardSorting/HEAV3NS-CODE-Releases/main/appcast-{architecture}.xml'
    if info.get('SUFeedURL') != expected_feed:
        raise ValueError('The app feed URL does not match its architecture')
    if len(base64.b64decode(signature, validate=True)) != 64:
        raise ValueError('Invalid Ed25519 signature')
    rss = ET.Element('rss', version='2.0')
    channel = ET.SubElement(rss, 'channel')
    ET.SubElement(channel, 'title').text = f'HEAV3NS-CODE for macOS ({architecture})'
    ET.SubElement(channel, 'link').text = 'https://heav3ns.com/code'
    ET.SubElement(channel, 'description').text = 'Signed stable HEAV3NS-CODE updates'
    item = ET.SubElement(channel, 'item')
    ET.SubElement(item, 'title').text = f'HEAV3NS-CODE {version}'
    ET.SubElement(item, sparkle('version')).text = str(build)
    ET.SubElement(item, sparkle('shortVersionString')).text = version
    minimum = info['LSMinimumSystemVersion'].split('.')
    ET.SubElement(item, sparkle('minimumSystemVersion')).text = '.'.join((minimum + ['0', '0'])[:3])
    ET.SubElement(item, 'pubDate').text = format_datetime(datetime.now(timezone.utc))
    ET.SubElement(item, 'link').text = f'https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/tag/v{version}'
    ET.SubElement(item, 'description').text = (
        'HEAV3NS-CODE includes native automatic update checks, signed downloads, and safe restart handling. '
        'Save edits and finish active requests before installing. Your library stays on this Mac.')
    ET.SubElement(item, 'enclosure', {
        'url': f'https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/download/v{version}/{archive.name}',
        'length': str(archive.stat().st_size), 'type': 'application/octet-stream',
        sparkle('edSignature'): signature,
    })
    if previous and previous.exists():
        for old in ET.parse(previous).getroot().findall('channel/item')[:9]:
            old_build = int(old.findtext(sparkle('version'), '0'))
            if old_build > int(build):
                raise ValueError('Refusing to move the stable feed to an older build')
            if old_build == int(build):
                enclosure = old.find('enclosure')
                current = item.find('enclosure')
                if enclosure is None or dict(enclosure.attrib) != dict(current.attrib) \
                        or old.findtext(sparkle('shortVersionString')) != version:
                    raise ValueError('Refusing to reuse a published build for different bytes or version')
            if old_build < int(build):
                channel.append(old)
    ET.indent(rss)
    return ET.tostring(rss, encoding='utf-8', xml_declaration=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archives', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--sparkle', type=Path, required=True)
    args = parser.parse_args()
    sign = args.sparkle / 'bin/sign_update'
    account = 'ed25519'
    key = subprocess.check_output([str(args.sparkle / 'bin/generate_keys'), '--account', account, '-p'], text=True).strip()
    if key != PUBLIC_KEY:
        raise ValueError('Keychain signing key does not match the key embedded in HEAV3NS-CODE')
    args.output.mkdir(parents=True, exist_ok=True)
    for arch in ('arm64', 'x86_64'):
        archive = args.archives / f'HEAV3NS-CODE-macOS-{arch}.zip'
        signature = subprocess.check_output([str(sign), '--account', account, '-p', str(archive)], text=True).strip()
        subprocess.run([str(sign), '--account', account, '--verify', str(archive), signature], check=True)
        with tempfile.TemporaryDirectory(prefix='heav3ns-code-appcast-') as temp:
            subprocess.run(['ditto', '-x', '-k', str(archive), temp], check=True)
            info = plistlib.loads((Path(temp) / 'HEAV3NS-CODE.app/Contents/Info.plist').read_bytes())
        feed = args.output / f'appcast-{arch}.xml'
        if feed.exists():
            # Never re-sign untrusted history copied from a compromised feed host.
            subprocess.run([str(sign), '--account', account, '--verify', str(feed)], check=True)
        content = make_feed(info, archive, signature, arch, previous=feed)
        feed.write_bytes(content)
        subprocess.run([str(sign), '--account', account, str(feed)], check=True)
        subprocess.run([str(sign), '--account', account, '--verify', str(feed)], check=True)
        print(f'Generated signed feed: {feed.name}, version {info["CFBundleShortVersionString"]}, build {info["CFBundleVersion"]}')


if __name__ == '__main__':
    main()
