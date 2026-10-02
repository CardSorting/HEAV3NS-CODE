"""Exercise Linux request semantics with the production DesktopSession test engine."""
import os
from pathlib import Path
import queue
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.transport import RuntimeClient


@unittest.skipUnless(os.environ.get('HEAV3NS_TEST_FIXTURE'), 'Build and set HEAV3NS_TEST_FIXTURE for scripted execution checks')
class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.command = [os.environ.get('HEAV3NS_NODE', 'node'), os.environ['HEAV3NS_TEST_FIXTURE']]
        self.client = RuntimeClient(self.folder.name, self.command)
        self.addCleanup(lambda: self.client.process.wait(timeout=12))
        self.addCleanup(lambda: self.client.close())
        self.client.connect()

    def request(self, method, params=None, identity=None):
        while not self.client.events.empty():
            self.client.events.get_nowait()
        return self.client.request(method, params, identity).result(10)

    def wait_state(self, run_id, state):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            snapshot = self.request('snapshot')
            for run in snapshot['runs']:
                if run['id'] == run_id and run['state'] == state:
                    return run
            time.sleep(.05)
        self.fail('Instruction never reached ' + state)

    def test_submit_queue_edit_remove_approval_output_and_reconnect(self):
        accepted = self.request('task.submit', {'text': 'First Linux instruction'}, 'linux-receipt')
        run_id = accepted['run']['id']
        run = self.wait_state(run_id, 'awaiting_approval')
        queued = self.request('task.submit', {'text': 'Queued instruction'}, 'linux-queued')['run']
        self.assertEqual(queued['state'], 'queued')
        edited = self.request('task.edit', {'run': queued['id'], 'revision': queued['revision'], 'text': 'Edited instruction'})
        self.assertEqual(edited['run']['text'], 'Edited instruction')
        self.request('task.cancel', {'run': queued['id'], 'ifQueued': True})
        self.request('approval.resolve', {'run': run_id, 'operation': run['approval']['operation'], 'decision': 'allow'})
        self.wait_state(run_id, 'completed')
        self.assertIn('No provider contacted', self.request('artifact.read', {'run': run_id})['text'])
        self.client.close()
        self.client.process.wait(timeout=12)
        self.client = RuntimeClient(self.folder.name, self.command)
        self.client.connect()
        lookup = self.request('task.lookup', {'request': 'linux-receipt'})
        self.assertTrue(lookup['found'])
        self.assertEqual(lookup['run']['id'], run_id)
        duplicate = self.request('task.submit', {'text': 'First Linux instruction'}, 'linux-receipt')
        self.assertTrue(duplicate['duplicate'])
        next_run = self.request('task.submit', {'text': 'Stop this instruction'})['run']['id']
        self.wait_state(next_run, 'awaiting_approval')
        self.request('task.cancelAll')
        self.wait_state(next_run, 'cancelled')


if __name__ == '__main__':
    unittest.main()
