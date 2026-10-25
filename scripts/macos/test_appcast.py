import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location('appcast', Path(__file__).resolve().parents[2] / 'scripts/macos/generate_appcast.py')
appcast = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(appcast)


class AppcastTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / 'HEAV3NS-CODE-macOS-arm64.zip'
        self.archive.write_bytes(b'final stapled archive')
        self.info = dict(CFBundleShortVersionString='2.0.1', CFBundleVersion='2',
                         LSMinimumSystemVersion='14.0', SUPublicEDKey=appcast.PUBLIC_KEY,
                         SURequireSignedFeed=True, SUVerifyUpdateBeforeExtraction=True,
                         SUFeedURL='https://raw.githubusercontent.com/CardSorting/HEAV3NS-CODE-Releases/main/appcast-arm64.xml')
        self.signature = base64.b64encode(bytes(64)).decode()

    def feed(self, **kwargs):
        return appcast.make_feed(self.info, self.archive, self.signature, 'arm64', **kwargs)

    def test_feed_uses_exact_signed_archive_version_build_and_minimum_os(self):
        item = ET.fromstring(self.feed()).find('channel/item')
        self.assertEqual(item.findtext(appcast.sparkle('version')), '2')
        self.assertEqual(item.findtext(appcast.sparkle('shortVersionString')), '2.0.1')
        self.assertEqual(item.findtext(appcast.sparkle('minimumSystemVersion')), '14.0.0')
        enclosure = item.find('enclosure')
        self.assertEqual(enclosure.get('url'), 'https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/download/v2.0.1/HEAV3NS-CODE-macOS-arm64.zip')
        self.assertEqual(enclosure.get('length'), str(self.archive.stat().st_size))
        self.assertEqual(enclosure.get(appcast.sparkle('edSignature')), self.signature)

    def test_wrong_key_unsigned_configuration_or_wrong_architecture_is_rejected(self):
        for key, value in [('SUPublicEDKey', 'other key'), ('SURequireSignedFeed', False),
                           ('SUVerifyUpdateBeforeExtraction', False), ('SUFeedURL', 'https://example.com/intel.xml')]:
            with self.subTest(key=key):
                original = self.info[key]
                self.info[key] = value
                with self.assertRaises(ValueError):
                    self.feed()
                self.info[key] = original

    def test_feed_cannot_move_to_an_older_build(self):
        self.info['CFBundleVersion'] = '5'
        previous = Path(self.temp.name) / 'previous.xml'
        previous.write_bytes(self.feed())
        self.info['CFBundleVersion'] = '2'
        with self.assertRaisesRegex(ValueError, 'older build'):
            self.feed(previous=previous)

    def test_retains_prior_releases_without_duplicate_builds(self):
        previous = Path(self.temp.name) / 'previous.xml'
        previous.write_bytes(self.feed())
        same = ET.fromstring(self.feed(previous=previous))
        self.assertEqual(len(same.findall('channel/item')), 1)
        self.info['CFBundleVersion'] = '3'
        self.info['CFBundleShortVersionString'] = '2.0.2'
        newer = ET.fromstring(self.feed(previous=previous))
        self.assertEqual([x.findtext(appcast.sparkle('version')) for x in newer.findall('channel/item')], ['3', '2'])

    def test_invalid_signature_and_build_are_rejected(self):
        self.signature = base64.b64encode(b'invalid').decode()
        with self.assertRaises(ValueError):
            self.feed()
        self.signature = base64.b64encode(bytes(64)).decode()
        self.info['CFBundleVersion'] = 'build-two'
        with self.assertRaises(ValueError):
            self.feed()

    def test_build_number_cannot_be_reused_for_changed_version_or_archive(self):
        previous = Path(self.temp.name) / 'previous.xml'
        previous.write_bytes(self.feed())
        self.info['CFBundleShortVersionString'] = '2.0.2'
        with self.assertRaisesRegex(ValueError, 'reuse a published build'):
            self.feed(previous=previous)
        self.info['CFBundleShortVersionString'] = '2.0.1'
        self.archive.write_bytes(b'changed archive bytes')
        self.signature = base64.b64encode(bytes([1]) * 64).decode()
        with self.assertRaisesRegex(ValueError, 'reuse a published build'):
            self.feed(previous=previous)


if __name__ == '__main__':
    unittest.main()
