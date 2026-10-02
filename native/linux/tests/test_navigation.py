import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.navigation import Destination, History, RequestGate, elapsed, matches, outline, safe_file
from heav3ns_code.presentation import render_evidence
from heav3ns_code.state import StateStore


class NavigationTests(unittest.TestCase):
    def test_history_branches_and_is_bounded_without_retaining_content(self):
        history = History(3)
        targets = [Destination.create(str(i), 'files.read', {'path': str(i)}, True) for i in range(5)]
        for target in targets:
            history.visit(target)
        self.assertEqual(history.entries, targets[-3:])
        history.visit(targets[-1])
        self.assertEqual(len(history.entries), 3)
        self.assertEqual(history.move(-1), targets[-2])
        history.visit(targets[0])
        self.assertFalse(history.can_forward)
        self.assertEqual(history.current.arguments(), {'path': '0'})

    def test_latest_query_and_lifecycle_gate(self):
        gate = RequestGate()
        first = gate.issue('search')
        second = gate.issue('search')
        independent = gate.issue('status')
        self.assertFalse(gate.accepts(first))
        self.assertTrue(gate.accepts(second))
        self.assertTrue(gate.accepts(independent))
        gate.invalidate()
        self.assertFalse(gate.accepts(second))
        self.assertFalse(gate.accepts(independent))

    def test_search_handles_unordered_tokens_accents_and_unicode(self):
        self.assertTrue(matches('cafe saved', 'Saved Café output'))
        self.assertTrue(matches('日本', '日本語.py'))
        self.assertFalse(matches('queue unknown', 'Queued instructions'))
        self.assertTrue(matches('', 'Any action'))

    def test_outline_is_bounded_page_local_and_explicitly_lexical(self):
        self.assertEqual(outline('class Example:\n    async def run(self):\n        pass', 'hello.py')[1][:2], (1, 'run'))
        self.assertEqual(outline('export async function run() {}', 'hello.ts')[0][1], 'run')
        self.assertEqual(outline('Heading', 'README.md'), [])
        self.assertEqual(len(outline('\n'.join(f'def f{i}(): pass' for i in range(200)), 'large.py')), 100)

    def test_file_links_never_treat_parent_paths_as_navigation(self):
        for path in ('../secret', '/etc/passwd', 'a/../../b', 'a\\b', '', None):
            self.assertFalse(safe_file(path))
        self.assertTrue(safe_file('src/日本語.py'))

    def test_timing_uses_recorded_start_and_terminal_end(self):
        self.assertEqual(elapsed({'state': 'running', 'startedAt': 1000}, 62), '1:01')
        self.assertEqual(elapsed({'state': 'completed', 'startedAt': 1000, 'updatedAt': 2000}, 1000), '0:01')
        self.assertEqual(elapsed({'state': 'queued'}, 50), 'Not started')

    def test_readable_run_evidence_does_not_infer_checks_passed(self):
        result = render_evidence('history.read', {'run': {'state': 'completed', 'text': 'Build'},
            'insight': {'checks': 'No project checks were run.'}, 'storedEvidence': 'verified'})
        self.assertIn('No project checks were run.', result)
        self.assertIn('does not verify project files', result)
        self.assertIn('Instruction\nBuild', result)


class StateRecoveryTests(unittest.TestCase):
    def test_sidebar_preferences_roundtrip_and_reject_invalid_geometry(self):
        with tempfile.TemporaryDirectory() as root:
            store = StateStore(root)
            preferences = {'sidebar': False, 'context': True, 'width': 440, 'tab': 'changes'}
            store.write('workspace', {'drafts': {'one': 'Unsent'}, 'layout': preferences})
            self.assertEqual(store.read('workspace')['layout'], preferences)
            with self.assertRaises(OSError):
                store.write('workspace', {'layout': {'width': -100}})
            self.assertEqual(store.read('workspace')['drafts']['one'], 'Unsent')

    def test_corrupt_receipt_blocks_overwrite_until_explicit_preserved_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            store = StateStore(root)
            original = b'{"pending": {"id": "possibly-accepted"}}'
            store.path('workspace').write_bytes(original)
            self.assertEqual(store.read('workspace', {}), {})
            self.assertIn('workspace', store.problems)
            with self.assertRaises(OSError):
                store.write('workspace', {'drafts': {}})
            self.assertEqual(store.path('workspace').read_bytes(), original)
            backup = store.recover('workspace')
            self.assertEqual(backup.read_bytes(), original)
            store.write('workspace', {'drafts': {'one': 'preserved new draft'}})
            self.assertEqual(store.read('workspace')['drafts']['one'], 'preserved new draft')

    def test_symlinks_and_invalid_library_shapes_are_not_followed_or_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            store = StateStore(root)
            outside = Path(root) / 'original.txt'
            outside.write_text('original')
            store.path('workspace').symlink_to(outside)
            self.assertEqual(store.read('workspace', {}), {})
            self.assertIn('workspace', store.problems)
            with self.assertRaises(OSError):
                store.write('workspace', {})
            self.assertEqual(outside.read_text(), 'original')
            store.path('projects').write_text('[{"path":"relative"}]')
            self.assertEqual(store.read('projects', []), [])
            self.assertIn('projects', store.problems)

    def test_rejects_state_path_traversal_and_nonfinite_dates(self):
        with tempfile.TemporaryDirectory() as root:
            store = StateStore(root)
            with self.assertRaises(ValueError):
                store.write('../outside', {})
            with self.assertRaises(OSError):
                store.write('projects', [{'path': '/tmp', 'opened': float('nan')}])


if __name__ == '__main__':
    unittest.main()
