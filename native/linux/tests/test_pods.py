"""Pods projection and shared command races, independent of GTK or providers."""
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.pod_model import FeedState, MAX_FEED, duration, includes, snapshot, stream_text
from heav3ns_code.workspace_commands import WorkspaceCommands, approval_identity
from heav3ns_code.transport import ProtocolError, RuntimeRejected


class Owner:
    def __init__(self, folder='/projects/Atlas'):
        self.folder = folder
        self.client = SimpleNamespace(ready=True, closed=False, capabilities={'approval', 'cancel', 'checkpoints-v1'},
                                      process=SimpleNamespace(poll=lambda: None))
        self.closed = self.switching = self.submitting = False
        self.connected_once = True
        self.pending_submission = None
        self.conversation = 'conversation-one'
        self.title = SimpleNamespace(get_text=lambda: 'Café navigation')
        self.active, self.queued = 'one', []
        self.runs = {'one': dict(id='one', text='Review navigation', state='awaiting_approval',
                                createdAt=1000, startedAt=2000, updatedAt=3000,
                                approval=dict(operation='op-one', args='{"command":"check"}',
                                              reason='Review checks', scope=folder, tool='command', createdAt=3000))}
        self.calls, self.errors, self.refreshes = [], [], 0
        self.commands = WorkspaceCommands(self)

    def rpc(self, method, params, success=None, error=None):
        self.calls.append((method, params, success, error))

    def refresh(self):
        self.refreshes += 1

    def update_controls(self):
        self.commands.sync()

    def show_error(self, value):
        self.errors.append(str(value))


class CommandTests(unittest.TestCase):
    def test_cross_surface_double_decision_and_acknowledged_old_snapshot_are_blocked(self):
        owner = Owner()
        key = approval_identity(owner)
        self.assertTrue(owner.commands.decide(key, 'allow'))
        self.assertFalse(owner.commands.decide(key, 'deny'))
        owner.calls[0][2]({'resolved': True})
        self.assertFalse(owner.commands.decide(key, 'allow'))
        self.assertEqual(len(owner.calls), 1)
        owner.runs['one']['approval']['decision'] = 'allow'
        owner.commands.sync()
        self.assertIsNone(owner.commands.approval_pending)
        self.assertIsNone(approval_identity(owner))

    def test_exact_reviewed_arguments_scope_and_worker_are_rechecked(self):
        for change in ('args', 'conversation', 'worker', 'switching', 'closed', 'capability'):
            with self.subTest(change=change):
                owner = Owner()
                key = approval_identity(owner)
                if change == 'args':
                    owner.runs['one']['approval']['args'] = 'changed command under the same operation'
                elif change == 'conversation':
                    owner.conversation = 'two'
                elif change == 'worker':
                    owner.client = SimpleNamespace(**vars(owner.client))
                elif change == 'capability':
                    owner.client.capabilities.clear()
                else:
                    setattr(owner, change, True)
                self.assertFalse(owner.commands.decide(key, 'allow'))
                self.assertEqual(owner.calls, [])

    def test_rejection_can_retry_but_unknown_outcome_cannot(self):
        for error, retry in ((RuntimeRejected('Not accepted'), True), (ProtocolError('Outcome unknown'), False)):
            owner = Owner()
            key = approval_identity(owner)
            owner.commands.decide(key, 'allow')
            owner.calls[0][3](error)
            self.assertEqual(owner.commands.can_decide(key), retry)
            self.assertEqual(owner.commands.approval_error, str(error))

    def test_late_reply_cannot_release_a_replacement_decision(self):
        owner = Owner()
        owner.commands.decide(approval_identity(owner), 'allow')
        old = owner.calls[-1]
        owner.runs['one']['approval']['operation'] = 'two'
        key = approval_identity(owner)
        owner.commands.decide(key, 'deny')
        old[3](RuntimeRejected('Old request'))
        self.assertEqual(owner.commands.approval_pending, key)
        self.assertEqual(owner.errors, [])

    def test_stop_is_shared_blocks_decisions_and_never_affects_another_project(self):
        owner, second = Owner(), Owner('/projects/Beacon')
        self.assertTrue(owner.commands.stop())
        self.assertFalse(owner.commands.stop())
        self.assertFalse(owner.commands.decide(approval_identity(owner), 'allow'))
        owner.calls[-1][2]({'requested': True})
        self.assertFalse(owner.commands.can_stop())
        self.assertTrue(second.commands.can_decide(approval_identity(second)))
        self.assertEqual(second.calls, [])
        owner.active = None
        owner.commands.sync()
        self.assertFalse(owner.commands.stop_pending)

    def test_queued_only_work_can_stop_and_rejected_stop_can_retry(self):
        owner = Owner()
        owner.active, owner.queued = None, ['queued']
        self.assertTrue(owner.commands.stop())
        owner.calls[-1][3](RuntimeRejected('Busy control channel'))
        self.assertTrue(owner.commands.can_stop())

    def test_late_stop_failure_cannot_release_the_stop_for_a_new_run(self):
        owner = Owner()
        owner.commands.stop()
        old = owner.calls[-1]
        owner.active = None
        owner.commands.sync()
        owner.active = 'two'
        owner.commands.stop()
        old[3](RuntimeRejected('Old stop failed'))
        self.assertTrue(owner.commands.stop_pending)
        self.assertEqual(owner.commands.stop_error, '')
        self.assertEqual(owner.errors, [])

    def test_reconnect_can_recover_missing_runtime_but_never_overlaps_a_worker(self):
        owner = Owner()
        self.assertFalse(owner.commands.can_reconnect())
        owner.client.closed = True
        self.assertFalse(owner.commands.can_reconnect())
        owner.client.process.poll = lambda: 0
        self.assertTrue(owner.commands.can_reconnect())
        owner.client = None
        self.assertTrue(owner.commands.can_reconnect())


class ProjectionTests(unittest.TestCase):
    def test_filter_searches_instruction_thread_and_unicode_without_mutation(self):
        owner = Owner()
        value = snapshot(owner, 10_000)
        self.assertTrue(includes(value, 'attention', 'cafe atlas'))
        self.assertTrue(includes(value, 'all', 'navigation'))
        self.assertFalse(includes(value, 'working', ''))
        self.assertFalse(includes(value, 'all', 'unrelated'))
        self.assertEqual(owner.calls, [])

    def test_connection_and_terminal_states_are_honest_and_active_run_wins(self):
        owner = Owner()
        owner.runs['newer'] = dict(id='newer', text='Queued task', state='queued', createdAt=9000)
        self.assertEqual(snapshot(owner, 10_000)['run']['id'], 'one')
        owner.client.closed = True
        value = snapshot(owner, 10_000)
        self.assertEqual(value['status'], 'Disconnected')
        self.assertFalse(value['running'])
        self.assertTrue(value['attention'])
        owner.client.closed, owner.active = False, None
        owner.runs['newer']['state'] = 'failed'
        self.assertEqual(snapshot(owner, 10_000)['status'], 'Failed')
        owner.pending_submission = {'id': 'uncertain'}
        self.assertEqual(snapshot(owner, 10_000)['status'], 'Check connection')

    def test_timing_uses_durable_dates_without_claiming_a_quiet_agent_is_stalled(self):
        owner = Owner()
        value = snapshot(owner, 10_000)
        self.assertIn('Waiting 7s for you', value['timing'])
        owner.runs['one']['state'] = 'running'
        value = snapshot(owner, 2000 + 27 * 3600_000)
        self.assertIn('Elapsed 1d 3h', value['timing'])
        self.assertIn('does not confirm it is stalled', value['note'])
        owner.active = None
        owner.runs['one']['state'] = 'completed'
        self.assertIn('Duration 1s', snapshot(owner, 999999)['timing'])
        self.assertEqual(duration(float('nan')), '0s')
        self.assertEqual(duration(-3), '0s')

    def test_feed_is_bounded_keeps_latest_activity_and_labels_limited_coverage(self):
        run = dict(activities=[dict(sequence=i, message=f'Activity {i}', detail='界' * 3000,
                                    metadata={'files': ['file.py']}) for i in range(100)],
                   activityCount=150, response='result' * 5000)
        text = stream_text(run)
        self.assertLessEqual(len(text), MAX_FEED)
        self.assertIn('Activity 99', text)
        self.assertNotIn('Activity 0 ·', text)
        self.assertIn('of 150 observed activities', text)
        self.assertIn('Preview shortened', text)
        self.assertIn('LUMI\nresult', text)

    def test_paused_feed_replaces_latest_without_growing_a_queue_and_resets_on_new_run(self):
        feed = FeedState()
        feed.update('first', 'run')
        for i in range(1000):
            feed.update(str(i), 'run', reading=True)
        self.assertEqual(feed.displayed, 'first')
        self.assertEqual(feed.latest, '999')
        feed.resume()
        self.assertEqual(feed.displayed, '999')
        feed.update('new run', 'second', reading=True)
        self.assertFalse(feed.paused)
        self.assertEqual(feed.displayed, 'new run')


if __name__ == '__main__':
    unittest.main()
