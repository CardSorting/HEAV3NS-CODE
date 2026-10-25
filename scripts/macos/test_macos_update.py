"""Exercise the release installer without network access or a real installation."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/macos/install.sh"
REPO = "https://github.com/CardSorting/HEAV3NS-CODE-Releases/releases/download"


@unittest.skipUnless(Path('/usr/bin/plutil').exists(), 'Requires macOS plist tools')
class MacUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-update-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.app = self.root / 'Applications/HEAV3NS-CODE.app'
        self.download = self.root / 'download'
        self.download.mkdir()
        self.log = self.root / 'calls'
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin',
                        FIXTURE=str(self.download), CALL_LOG=str(self.log))
        self.tool('uname', 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi')
        self.tool('sw_vers', 'echo 26.0')
        self.tool('pgrep', 'exit 1')
        self.tool('file', 'echo "Mach-O 64-bit executable arm64"')
        self.tool('codesign', 'echo "$*" >> "$CALL_LOG"; exit "${SIGNATURE_FAIL:-0}"')
        self.tool('spctl', 'exit "${GATEKEEPER_FAIL:-0}"')
        self.tool('curl', '''url=""; output=""
while (( $# )); do
  case "$1" in --output) output="$2"; shift;; https://*) url="$1";; esac
  shift
done
echo "$url" >> "$CALL_LOG"
case "$url" in
  *api.github.com*) cp "$FIXTURE/releases.json" "$output";;
  */SHA256SUMS.txt) cp "$FIXTURE/SHA256SUMS.txt" "$output";;
  *.zip) cp "$FIXTURE/archive.zip" "$output";;
  *) exit 22;;
esac''')
        self.tool('ditto', '''if [[ "$1" == -x ]]; then
  cp -R "$FIXTURE/HEAV3NS-CODE.app" "$4/"
else
  cp -R "$1" "$2"
fi''')
        self.releases('v2.0.0')
        self.bundle(self.download / 'HEAV3NS-CODE.app', '2.0.0')
        (self.download / 'archive.zip').write_bytes(b'fixture')
        import hashlib
        checksum = hashlib.sha256(b'fixture').hexdigest()
        (self.download / 'SHA256SUMS.txt').write_text(f'{checksum}  HEAV3NS-CODE-macOS-arm64.zip\n')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/bash\nset -eu\n' + body + '\n')
        path.chmod(0o755)

    def bundle(self, path, version, identifier='io.heav3ns.code'):
        (path / 'Contents/MacOS').mkdir(parents=True)
        (path / 'Contents/Resources/runtime').mkdir(parents=True)
        (path / 'Contents/MacOS/HEAV3NS-CODE').write_text('native')
        (path / 'Contents/Resources/runtime/node').write_text('server')
        (path / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': identifier, 'CFBundleShortVersionString': version}))

    def releases(self, *tags):
        (self.download / 'releases.json').write_text(json.dumps([
            dict(tag_name=tag, draft=False, prerelease=False, assets=[
                dict(name='HEAV3NS-CODE-macOS-arm64.zip', browser_download_url=f'{REPO}/{tag}/HEAV3NS-CODE-macOS-arm64.zip'),
                dict(name='SHA256SUMS.txt', browser_download_url=f'{REPO}/{tag}/SHA256SUMS.txt')])
            for tag in tags]))

    def run_installer(self, *args):
        return subprocess.run(['/bin/bash', str(SCRIPT), '--app', str(self.app), *args],
                              env=self.env, capture_output=True, text=True)

    def test_check_selects_highest_version_without_downloading(self):
        self.releases('v2.0.1', 'v2.10.0', 'v2.9.0')
        result = self.run_installer('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('v2.10.0 is available', result.stdout)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)
        self.assertFalse(self.app.exists())

    def test_equal_and_older_releases_leave_installation_untouched(self):
        self.bundle(self.app, '2.1.0')
        result = self.run_installer('v2.0.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('No downgrade', result.stdout)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)

    def test_install_verifies_pinned_signer_and_keeps_backup(self):
        self.bundle(self.app, '1.9.0')
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('C35F6CCNLU', self.log.read_text())
        self.assertIn('identifier "io.heav3ns.code"', self.log.read_text())
        self.assertEqual(len(list(self.app.parent.glob('HEAV3NS-CODE.previous.*.app'))), 1)
        self.assertFalse((self.app.parent / '.HEAV3NS-CODE.update.lock').exists())

    def test_bad_checksum_leaves_old_installation_untouched(self):
        self.bundle(self.app, '1.9.0')
        (self.download / 'SHA256SUMS.txt').write_text('0' * 64 + '  HEAV3NS-CODE-macOS-arm64.zip\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA-256 verification failed', result.stderr)
        self.assertFalse(list(self.app.parent.glob('HEAV3NS-CODE.previous.*.app')))

    def test_duplicate_checksum_is_rejected(self):
        manifest = self.download / 'SHA256SUMS.txt'
        manifest.write_text(manifest.read_text() * 2)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exactly one entry', result.stderr)

    def test_wrong_archive_version_is_rejected(self):
        info = self.download / 'HEAV3NS-CODE.app/Contents/Info.plist'
        data = plistlib.loads(info.read_bytes())
        data['CFBundleShortVersionString'] = '1.0.0'
        info.write_bytes(plistlib.dumps(data))
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive version does not match', result.stderr)

    def test_wrong_signer_or_gatekeeper_failure_is_rejected(self):
        for key in ('SIGNATURE_FAIL', 'GATEKEEPER_FAIL'):
            with self.subTest(key=key):
                self.env[key] = '1'
                result = self.run_installer()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.app.exists())
                del self.env[key]

    def test_lock_prevents_concurrent_replacement(self):
        self.bundle(self.app, '1.9.0')
        lock = self.app.parent / '.HEAV3NS-CODE.update.lock'
        lock.mkdir()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another install', result.stderr)
        self.assertTrue(lock.exists())
        self.assertFalse(list(self.app.parent.glob('HEAV3NS-CODE.previous.*.app')))

    def test_incomplete_newer_release_is_skipped(self):
        self.releases('v2.1.0', 'v2.0.0')
        releases = json.loads((self.download / 'releases.json').read_text())
        releases[0]['assets'].pop()
        (self.download / 'releases.json').write_text(json.dumps(releases))
        result = self.run_installer('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('v2.0.0 is available', result.stdout)


if __name__ == '__main__':
    unittest.main()
