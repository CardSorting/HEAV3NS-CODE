"""Deterministic callback races and GTK navigation without a provider."""
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.widgets import Panel, text_value
from heav3ns_code.inspector import Inspector
from heav3ns_code.pickers import CommandPalette, QuickOpen
from gi.repository import Gtk, GLib

Gtk.init()


class Owner(Gtk.Window):
    def __init__(self):
        super().__init__()
        self.client = SimpleNamespace(ready=True, closed=False, runtime='runtime')
        self.conversation = 'one'
        self.closed = False
        self.panels = set()
        self.calls = []
        self.invoked = []
        self.enabled = True
    def rpc(self, method, params, callback, error):
        self.calls.append((method, params, callback, error))
    def actions(self):
        return [dict(id='files', title='Open file', shortcut='Ctrl+P', enabled=self.enabled,
                     callback=lambda: self.invoked.append('files'), keywords='code filename')]
    def memory(self):
        pass
    def evidence(self, *args):
        self.invoked.append(args)


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.owner = Owner()
    def tearDown(self):
        for panel in list(self.owner.panels):
            panel.destroy()
        self.owner.destroy()
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)

    def test_late_search_replies_and_closed_panels_cannot_deliver(self):
        panel = Panel(self.owner, 'Test')
        received = []
        panel.request('files.search', {'query': 'first'}, received.append)
        panel.request('files.search', {'query': 'second'}, received.append)
        self.owner.calls[1][2]({'query': 'second'})
        self.owner.calls[0][2]({'query': 'first'})
        self.assertEqual(received, [{'query': 'second'}])
        panel.request('files.read', {}, received.append)
        panel.destroy()
        self.owner.calls[-1][2]({'text': 'late'})
        self.assertEqual(len(received), 1)

    def test_conversation_and_connection_changes_invalidate_mutations(self):
        panel = Panel(self.owner, 'Memory')
        self.owner.conversation = 'two'
        panel.request('memory.write', {'value': 'stale'})
        self.assertEqual(self.owner.calls, [])
        self.assertFalse(panel.body.get_sensitive())
        second = Panel(self.owner, 'Models')
        self.owner.client = SimpleNamespace(ready=True, closed=False)
        second.request('models.select', {})
        self.assertEqual(self.owner.calls, [])

    def test_mutation_is_admitted_once_until_acknowledgement(self):
        panel = Panel(self.owner, 'Memory')
        panel.request('memory.write', {}, lambda _: None)
        panel.request('memory.write', {}, lambda _: None)
        self.assertEqual(len(self.owner.calls), 1)
        self.owner.calls[0][2]({})
        panel.request('memory.write', {})
        self.assertEqual(len(self.owner.calls), 2)

    def test_inspector_back_forward_reads_fresh_and_discards_old_destination(self):
        inspector = Inspector(self.owner)
        inspector.open('First', 'files.read', {'path': 'first.py'}, True)
        first = self.owner.calls[-1]
        inspector.open('Second', 'files.read', {'path': 'second.py'}, True)
        self.owner.calls[-1][2]({'text': 'second page', 'size': 11, 'nextOffset': 11, 'revision': 'r2'})
        first[2]({'text': 'stale first page', 'size': 16, 'nextOffset': 16, 'revision': 'r1'})
        self.assertEqual(text_value(inspector.view), 'second page')
        inspector.travel(-1)
        self.assertEqual(self.owner.calls[-1][1], {'path': 'first.py', 'offset': 0})
        self.assertTrue(inspector.forward.get_sensitive())

    def test_inspector_previous_page_revision_find_and_outline(self):
        inspector = Inspector(self.owner)
        inspector.open('Example', 'files.read', {'path': 'example.py'}, True)
        self.owner.calls[-1][2]({'text': 'class Example:\n    def run(self): pass\n', 'size': 100, 'nextOffset': 40, 'revision': 'saved'})
        inspector.focus_find()
        inspector.search.set_text('Example')
        inspector.find(reset=True)
        self.assertTrue(inspector.view.get_buffer().get_selection_bounds())
        self.assertTrue(inspector.outline.get_visible())
        inspector.outline.set_active_id('1')
        inspector.turn_page(1)
        self.assertEqual(self.owner.calls[-1][1]['revision'], 'saved')
        self.owner.calls[-1][2]({'text': 'page two', 'size': 100, 'nextOffset': 100, 'revision': 'saved'})
        inspector.turn_page(-1)
        self.assertEqual(self.owner.calls[-1][1]['offset'], 0)
        self.assertEqual(self.owner.calls[-1][1]['revision'], 'saved')
        inspector.reload()
        self.assertNotIn('revision', self.owner.calls[-1][1])

    def test_palette_rechecks_enabled_state_and_empty_search_never_activates(self):
        picker = CommandPalette(self.owner)
        row = picker.items.get_selected_row()
        self.owner.enabled = False
        picker.activate(row)
        self.assertEqual(self.owner.invoked, [])
        picker.query.set_text('not-an-action')
        picker.populate()
        picker.activate(picker.items.get_selected_row())
        self.assertEqual(self.owner.invoked, [])

    def test_quick_open_cannot_activate_previous_query_results(self):
        picker = QuickOpen(self.owner)
        first = self.owner.calls[-1]
        picker.query.set_text('second')
        picker.schedule()
        first[2]({'entries': [{'path': 'first.py'}], 'matched': 1})
        self.assertIsNone(picker.items.get_selected_row())
        picker.activate(None)
        self.assertEqual(self.owner.invoked, [])

    def test_typing_then_enter_before_search_debounce_never_opens_old_file(self):
        picker = QuickOpen(self.owner)
        self.owner.calls[-1][2]({'entries': [{'path': 'first.py'}], 'matched': 1})
        self.assertIsNotNone(picker.items.get_selected_row())
        picker.query.set_text('second')
        picker.query.emit('activate')
        self.assertEqual(self.owner.invoked, [])
        self.assertIsNone(picker.items.get_selected_row())


class SidebarTests(unittest.TestCase):
    def setUp(self):
        self.owner = Owner()
        self.views = []

    def tearDown(self):
        for view in self.views:
            view.destroy()
        self.owner.destroy()
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)

    def browser(self):
        from heav3ns_code.context_browser import ContextBrowser
        view = ContextBrowser(self.owner)
        self.views.append(view)
        return view

    def test_folder_query_immediately_invalidates_selected_rows_and_late_results(self):
        browser = self.browser()
        browser.reload()
        self.owner.calls[-1][2]({'entries': [{'path': 'old.py', 'name': 'old.py'}], 'matched': 1})
        row = browser.items.get_row_at_index(0)
        browser.items.select_row(row)
        browser.query.set_text('new')
        browser.activate(row)
        self.assertEqual(self.owner.invoked, [])
        self.assertIsNone(browser.items.get_first_child())
        browser.reload()
        old = self.owner.calls[-1]
        browser.folder('src')
        self.owner.calls[-1][2]({'entries': [{'name': 'new.py', 'path': 'src/new.py'}], 'matched': 1})
        old[2]({'entries': [{'name': 'old.py', 'path': 'old.py'}], 'matched': 1})
        self.assertEqual(browser.items.get_row_at_index(0).entry['path'], 'src/new.py')

    def test_folder_paging_and_parent_reset_offset(self):
        browser = self.browser()
        browser.reload()
        self.owner.calls[-1][2]({'entries': [{'name': 'src', 'path': 'src', 'directory': True}], 'more': True, 'nextOffset': 100, 'matched': 101})
        browser.page(1)
        self.assertEqual(self.owner.calls[-1][1]['offset'], 100)
        browser.folder('src/nested')
        browser.parent_folder()
        self.assertEqual(self.owner.calls[-1][1]['path'], 'src')
        self.assertEqual(self.owner.calls[-1][1]['offset'], 0)

    def test_change_activation_distinguishes_staged_and_untracked(self):
        browser = self.browser()
        browser.configure('changes')
        self.owner.calls[-1][2]({'entries': [{'path': 'index.py', 'name': 'index.py', 'staged': True, 'unstaged': True}, {'path': 'new.py', 'name': 'new.py', 'untracked': True, 'unstaged': True}]})
        browser.scope.set_active_id('staged')
        browser.activate(browser.items.get_row_at_index(0))
        self.assertEqual(self.owner.invoked[-1][1:3], ('changes.read', {'path': 'index.py', 'staged': True}))
        browser.scope.set_active_id('all')
        browser.activate(browser.items.get_row_at_index(1))
        self.assertEqual(self.owner.invoked[-1][1], 'files.read')

    def test_conflicts_are_distinct_and_only_open_a_selected_working_diff(self):
        browser = self.browser()
        browser.configure('changes')
        self.owner.calls[-1][2]({'branch': 'main', 'entries': [
            {'path': 'conflict.py', 'name': 'conflict.py', 'conflicted': True, 'staged': False, 'unstaged': True},
            {'path': 'staged.py', 'name': 'staged.py', 'staged': True, 'unstaged': False},
            {'path': 'new.py', 'name': 'new.py', 'untracked': True, 'unstaged': True}]})
        self.assertIn('1 merge conflict', browser.message.get_text())
        browser.scope.set_active_id('conflicts')
        self.assertEqual([row.entry['path'] for row in browser.items], ['conflict.py'])
        self.assertIn('Merge conflict', browser.items.get_row_at_index(0).get_tooltip_text())
        self.assertFalse(browser.all_diff.get_visible())
        browser.open_full_diff()
        self.assertEqual(self.owner.invoked, [])
        browser.activate(browser.items.get_row_at_index(0))
        self.assertEqual(self.owner.invoked[-1][1:3], ('changes.read', {'path': 'conflict.py', 'staged': False}))
        browser.scope.set_active_id('staged')
        self.assertEqual([row.entry['path'] for row in browser.items], ['staged.py'])
        self.assertEqual(browser.all_diff.get_label(), 'Staged diff')
        browser.scope.set_active_id('conflicts')
        browser.entries = []
        browser.render()
        self.assertIn('No merge conflicts.', browser.message.get_text())

    def test_git_setup_is_explicit_deduplicated_and_reloads_after_success(self):
        self.owner.client.capabilities = {'repository-initialize-v1'}
        browser = self.browser()
        browser.configure('changes')
        self.assertFalse(browser.all_diff.get_sensitive())
        self.owner.calls[-1][3]('GIT_NOT_REPOSITORY: Initialize this folder.\n\nfatal: not a git repository')
        self.assertTrue(browser.git_setup.get_visible())
        self.assertTrue(browser.initialize.get_visible())
        self.assertFalse(browser.error.get_visible())
        browser.scope.set_active_id('staged')
        self.assertIn('Inspect', browser.message.get_text())
        browser.open_full_diff()
        self.assertEqual(self.owner.invoked, [])
        self.assertEqual([c[0] for c in self.owner.calls], ['changes.list'])
        browser.initialize.emit('clicked')
        browser.initialize_repository()
        browser.reload()
        self.assertEqual([c[0] for c in self.owner.calls], ['changes.list', 'repository.initialize'])
        self.owner.calls[-1][2]({'initialized': True})
        self.assertEqual(self.owner.calls[-1][0], 'changes.list')
        self.owner.calls[-1][2]({'branch': 'main', 'entries': []})
        self.assertFalse(browser.git_setup.get_visible())
        self.assertTrue(browser.all_diff.get_sensitive())

    def test_git_errors_never_offer_initialization_or_turn_into_a_clean_list(self):
        self.owner.client.capabilities = {'repository-initialize-v1'}
        browser = self.browser()
        browser.configure('changes')
        self.owner.calls[-1][3]('GIT_OWNERSHIP: Check project ownership.\n\nfatal: dubious ownership')
        browser.query.set_text('test')
        self.assertFalse(browser.initialize.get_visible())
        self.assertEqual(browser.git_title.get_text(), 'Check project ownership')
        browser.initialize_repository()
        self.assertEqual(len(self.owner.calls), 1)
        browser.configure('files')
        self.owner.calls[-1][2]({'entries': [], 'matched': 0})
        self.assertFalse(browser.git_setup.get_visible())
        browser.configure('changes')
        self.owner.calls[-1][3]('GIT_NOT_REPOSITORY: Initialize this folder.')
        self.owner.conversation = 'changed'
        browser.initialize_repository()
        self.assertNotEqual(self.owner.calls[-1][0], 'repository.initialize')

    def test_run_initialization_never_writes_healing_and_rejects_old_scope(self):
        from heav3ns_code.project_run import ProjectRun
        project = ProjectRun(self.owner)
        self.views.append(project)
        project.refresh()
        status = next(call for call in self.owner.calls if call[0] == 'project.status')
        status[2]({'state': 'idle', 'revision': 1, 'healing': {'enabled': True}})
        self.assertNotIn('project.healing', [call[0] for call in self.owner.calls])
        self.owner.conversation = 'two'
        before = len(self.owner.calls)
        project.command.set_text('echo new')
        project.save_command()
        self.assertEqual(len(self.owner.calls), before)
        self.assertFalse(project.body.get_sensitive())

    def test_activity_preview_selection_is_held_until_explicit_latest(self):
        from heav3ns_code.walkthrough import ActivityRow
        event = {'activityId': 'command', 'status': 'in_progress', 'message': 'Test output', 'preview': {'kind': 'output', 'text': 'original output'}}
        row = ActivityRow(self.owner, event)
        buffer = row.preview.get_buffer()
        buffer.select_range(buffer.get_start_iter(), buffer.get_end_iter())
        row.update({**event, 'preview': {'kind': 'output', 'text': 'new output'}})
        self.assertEqual(text_value(row.preview), 'original output')
        self.assertTrue(row.follow.get_visible())
        row.resume()
        self.assertEqual(text_value(row.preview), 'new output')

    def test_binary_preview_cannot_advance_to_another_text_page(self):
        inspector = Inspector(self.owner)
        self.views.append(inspector)
        inspector.open('Binary', 'files.read', {'path': 'blob.bin'}, True)
        self.owner.calls[-1][2]({'text': 'Binary file', 'binary': True, 'nextOffset': 20, 'size': 100, 'revision': 'one'})
        self.assertFalse(inspector.next.get_sensitive())


if __name__ == '__main__':
    unittest.main()
