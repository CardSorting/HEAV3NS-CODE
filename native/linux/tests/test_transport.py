import json
import os
from pathlib import Path
import queue
import stat
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.state import StateStore, authorization_url, preview_url
from heav3ns_code.transport import FrameDecoder, MAX_FRAME, ProtocolError, RuntimeClient

FAKE = r'''
import json, sys, time
for line in sys.stdin.buffer:
    request = json.loads(line)
    method = request['method']
    if method == 'hello':
        result = dict(protocol=1, workspace='workspace', session='session', runtime='runtime', capabilities=['snapshot'])
    elif method == 'snapshot':
        result = dict(workspace='workspace', session='session', runtime='runtime', conversation='session', runs=[], seq=0)
    elif method == 'files.search':
        continue
    elif method == 'stall':
        time.sleep(20)
        continue
    elif method == 'bad':
        sys.stdout.buffer.write(b'{"v":1}\xff\n'); sys.stdout.flush(); continue
    elif method == 'events':
        for runtime in ('wrong-runtime', 'runtime'):
            print(json.dumps(dict(v=1, kind='event', workspace='workspace', session='session', runtime=runtime, type='run.state', seq=1, payload={})), flush=True)
        result = {}
    elif method == 'notice':
        print(json.dumps(dict(v=1, kind='event', workspace='workspace', session='session', runtime='runtime', type='runtime.error', payload={'message': 'Notice'})), flush=True)
        result = {}
    else:
        result = request.get('params', {})
    print(json.dumps(dict(v=1, kind='response', id=request['id'], result=result)), flush=True)
'''


class TransportTests(unittest.TestCase):
    def test_close_discards_pending_display_and_write_buffers_and_rejects_late_frames(self):
        client = self.make_client()
        client.connect()
        event = dict(v=1, kind='event', workspace='workspace', session='session', runtime='runtime',
                     type='runtime.error', payload={'message': 'x' * 100_000})
        client._receive(event)
        self.assertEqual(client.events.qsize(), 1)
        client.close()
        client._receive(event)
        self.assertTrue(client.events.empty())
        self.assertTrue(client.writes.empty())

    def test_response_callback_close_blocks_the_remainder_of_a_burst(self):
        client = self.make_client()
        client.connect()
        future = client.request('files.search')
        identity = next(key for key, pending in client.pending.items() if pending[0] is future)
        future.add_done_callback(lambda _: client.close())
        client._receive(dict(v=1, kind='response', id=identity, result={}))
        client._receive(dict(v=1, kind='event', workspace='workspace', session='session', runtime='runtime',
                             type='runtime.error', payload={'message': 'late'}))
        self.assertTrue(client.closed)
        self.assertTrue(client.events.empty())

    def test_startup_error_is_visible_and_stderr_is_drained_with_bounded_memory(self):
        code = "import sys; sys.stderr.write('noise' * 20000 + '\\nWORKSPACE_OWNED: existing owner; close its session first.\\n'); sys.exit(1)"
        client = RuntimeClient(tempfile.gettempdir(), [sys.executable, '-u', '-c', code])
        self.addCleanup(lambda: client.process.wait(timeout=12))
        self.addCleanup(client.close)
        with self.assertRaisesRegex(ProtocolError, 'recorded owner'):
            client.connect()
        self.assertIn('WORKSPACE_OWNED:', client.failure)
        self.assertLessEqual(len(client.diagnostics), 16384)
        self.assertLess(len(client.failure), 8500)

    def test_unsequenced_runtime_notices_do_not_disconnect(self):
        client = self.make_client()
        client.connect()
        client.request('notice').result(3)
        self.assertEqual(client.events.get(timeout=1)['payload']['message'], 'Notice')
        self.assertTrue(client.ready)

    def test_fragmented_unicode_and_multiple_frames(self):
        payload = json.dumps({'v': 1, 'text': '🌙 café 日本語'}, ensure_ascii=False).encode() + b'\n'
        decoder = FrameDecoder()
        output = []
        for byte in payload + payload:
            output.extend(decoder.feed(bytes([byte])))
        self.assertEqual([item['text'] for item in output], ['🌙 café 日本語'] * 2)
        decoder.finish()

    def test_rejects_oversize_invalid_utf8_version_and_incomplete(self):
        for data in (b'x' * (MAX_FRAME + 1), b'{"v":1,"text":"\xff"}\n', b'{"v":2}\n', b'[]\n'):
            with self.assertRaises((ValueError, ProtocolError)):
                FrameDecoder().feed(data)
        decoder = FrameDecoder()
        decoder.feed(b'{"v":1}')
        with self.assertRaises(ProtocolError):
            decoder.finish()

    def make_client(self, **kwargs):
        client = RuntimeClient(tempfile.gettempdir(), [sys.executable, '-u', '-c', FAKE], **kwargs)
        self.addCleanup(lambda: client.process.wait(timeout=12))
        self.addCleanup(client.close)
        return client

    def test_handshake_identity_and_request_roundtrip(self):
        client = self.make_client()
        self.assertEqual(client.connect()['conversation'], 'session')
        self.assertTrue(client.ready)
        self.assertEqual(client.request('echo', {'text': '🌙'}).result(3), {'text': '🌙'})
        client.request('events').result(3)
        self.assertEqual(client.events.get(timeout=1)['runtime'], 'runtime')
        with self.assertRaises(queue.Empty):
            client.events.get_nowait()

    def test_timeout_fails_pending_requests_and_disables_execution(self):
        client = self.make_client(timeout=.25)
        client.connect()
        future = client.request('stall')
        pending = client.request('task.submit', {'text': 'keep this draft'})
        with self.assertRaises(ProtocolError):
            future.result(2)
        with self.assertRaisesRegex(ProtocolError, 'Acceptance unknown'):
            pending.result(2)
        self.assertFalse(client.ready)
        self.assertTrue(client.closed)

    def test_inspection_timeout_preserves_worker_and_controls(self):
        client = self.make_client(timeout=.2)
        client.connect()
        read = client.request('files.search', {'query': 'slow'})
        with self.assertRaisesRegex(ProtocolError, 'execution controls remain available'):
            read.result(2)
        self.assertTrue(client.ready)
        self.assertFalse(client.closed)
        self.assertEqual(client.request('task.cancelAll').result(2), {})

    def test_unsent_oversize_request_is_not_acceptance_uncertainty(self):
        from heav3ns_code.transport import RuntimeRejected
        client = self.make_client()
        client.connect()
        with self.assertRaises(RuntimeRejected):
            client.request('task.submit', {'text': 'x' * MAX_FRAME}).result(2)
        self.assertTrue(client.ready)

    def test_invalid_output_disconnects(self):
        client = self.make_client()
        client.connect()
        with self.assertRaises(ProtocolError):
            client.request('bad').result(3)
        self.assertTrue(client.closed)

    def test_close_reaps_worker_and_rejects_more_requests(self):
        client = self.make_client()
        client.connect()
        client.close()
        client.process.wait(timeout=3)
        with self.assertRaises(ProtocolError):
            client.request('task.submit').result()


class StateTests(unittest.TestCase):
    def test_private_atomic_state_and_workspace_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            store = StateStore(Path(folder) / 'state')
            value = {'drafts': {'one': '🌙 draft'}, 'pending': {'id': 'request', 'session': 'session', 'conversation': 'one', 'text': '🌙 draft'}}
            store.write('workspace', value)
            self.assertEqual(store.read('workspace'), value)
            self.assertEqual(stat.S_IMODE((store.root / 'workspace.json').stat().st_mode), 0o600)
            self.assertEqual(store.workspace_key(folder), store.workspace_key(folder + '/.'))
            self.assertIsNone(store.read('missing'))

    def test_browser_url_allowlists(self):
        self.assertTrue(authorization_url('https://auth.openai.com/oauth/authorize?state=123'))
        for value in ('http://auth.openai.com/oauth/authorize', 'https://auth.openai.com.evil.test/oauth/authorize',
                      'https://user@auth.openai.com/oauth/authorize', 'file:///etc/passwd',
                      'https://auth.openai.com:123/oauth/authorize', 'https://auth.openai.com/other'):
            self.assertFalse(authorization_url(value))
        self.assertTrue(preview_url('http://127.0.0.1:3000/'))
        self.assertTrue(preview_url('http://[::1]:3000/'))
        self.assertFalse(preview_url('https://example.com/'))
        self.assertFalse(preview_url('http://user@localhost/'))


@unittest.skipUnless(os.environ.get('HEAV3NS_TEST_CLI'), 'Set HEAV3NS_TEST_CLI to test the packaged real runtime')
class RuntimeIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        (self.folder / 'hello.txt').write_text('🌙 Linux runtime\n')
        (self.folder / 'index.html').write_text('<!doctype html><title>Linux preview</title><p>Hello</p>')
        self.command = [os.environ.get('HEAV3NS_NODE', 'node'), os.environ['HEAV3NS_TEST_CLI'], '--desktop-worker']
        self.client = RuntimeClient(self.folder, self.command)
        self.addCleanup(lambda: self.client.process.wait(timeout=12))
        self.addCleanup(lambda: self.client.close())
        self.snapshot = self.client.connect()

    def request(self, method, params=None):
        return self.client.request(method, params).result(30)

    def test_runtime_conversations_files_models_memory_preview_and_restart(self):
        initial = self.snapshot['conversation']
        self.assertIn('conversations', self.client.capabilities)
        self.assertEqual(self.request('files.read', {'path': 'hello.txt'})['text'], '🌙 Linux runtime\n')
        found = self.request('files.search', {'query': 'hello'})
        self.assertTrue(any(item['path'] == 'hello.txt' for item in found['entries']))
        with self.assertRaises(ProtocolError):
            self.request('files.read', {'path': '/etc/passwd'})
        models = self.request('models.list')
        self.assertTrue(models['providers'])
        self.assertIn('model', models)
        conversation = self.request('conversation.create')['conversation']
        self.assertNotEqual(conversation, initial)
        saved = self.request('memory.write', {'conversation': conversation, 'key': 'Linux test', 'value': 'Keep changes reviewable.', 'category': 'rule'})
        entries = self.request('memory.list', {'conversation': conversation})['entries']
        self.assertEqual(entries[0]['key'], 'Linux test')
        self.request('context.inspect', {'conversation': conversation})
        self.request('state.inspect', {'conversation': conversation})
        self.request('conversation.select', {'id': initial})
        self.assertEqual(self.request('memory.list', {'conversation': initial})['entries'], [])
        targets = self.request('project.discover')['targets']
        target = next(item for item in targets if item.get('kind') == 'static')
        status = self.request('project.start', {'id': target['id'], 'revision': target['revision']})
        self.assertEqual(status['state'], 'running')
        import urllib.request
        self.assertIn(b'Linux preview', urllib.request.urlopen(status['preview'], timeout=3).read())
        self.request('project.stop')
        self.client.close()
        self.client.process.wait(timeout=12)
        self.client = RuntimeClient(self.folder, self.command)
        self.assertEqual(self.client.connect()['conversation'], initial)
        self.request('conversation.select', {'id': conversation})
        self.assertEqual(self.request('memory.list', {'conversation': conversation})['entries'][0]['key'], 'Linux test')
        self.request('conversation.delete', {'id': conversation})


if __name__ == '__main__':
    unittest.main()
