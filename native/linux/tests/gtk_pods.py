"""Native Pods interactions, replacement approvals, feed selection and reflow."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.widgets import text_value
from heav3ns_code.approval import ApprovalView
from heav3ns_code.pods import Pods
from heav3ns_code.app import Application
from heav3ns_code.transport import RuntimeRejected
from test_pods import Owner
from gi.repository import Gdk, Gio, GLib, Gtk

Gtk.init()
callback_errors = []
sys.excepthook = lambda kind, value, trace: callback_errors.append(str(value))


def settle(seconds=.15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.005)


def capture(window, name):
    directory = os.environ.get('HEAV3NS_SCREENSHOT_DIR')
    if directory:
        import gi
        gi.require_version('GdkX11', '4.0')
        from gi.repository import GdkX11
        subprocess.run(['xwd', '-id', str(window.get_surface().get_xid()), '-silent',
                        '-out', str(Path(directory) / (name + '.xwd'))], check=True)


class Workspace(Owner):
    def __init__(self, folder):
        super().__init__(folder)
        self.presented = 0
        self.show_connection_details = lambda: None
        self.show_conversation = lambda: None
        self.composer = Gtk.TextView()

    def present(self):
        self.presented += 1


class PodsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = Gtk.Application(application_id='io.heav3ns.PodsTests', flags=Gio.ApplicationFlags.NON_UNIQUE)
        cls.app.register(None)

    def setUp(self):
        self.app.workspaces = {}
        self.app.pods_window = None
        self.app.show_library = lambda: None
        for name in ('Atlas', 'Beacon', 'Café'):
            owner = Workspace('/projects/' + name)
            self.app.workspaces[owner.folder] = owner
        self.owners = list(self.app.workspaces.values())
        self.pods = Pods(self.app)
        self.app.pods_window = self.pods
        settle()

    def tearDown(self):
        self.pods.destroy()
        settle(.03)
        self.assertEqual(callback_errors, [])

    def test_filters_find_task_and_next_request_clears_filters_without_approving(self):
        self.pods.query.set_text('projects/cafe navigation')
        self.pods.update()
        self.assertEqual([path for path, row in self.pods.rows.items() if row.view.get_visible()], ['/projects/Café'])
        self.pods.select_filter('working')
        self.assertTrue(self.pods.empty.get_visible())
        self.pods.focus_next_request()
        self.assertEqual(self.pods.mode, 'all')
        self.assertEqual(self.pods.query.get_text(), '')
        self.assertEqual(self.pods.last_reviewed, self.owners[0].folder)
        self.pods.focus_next_request()
        self.assertEqual(self.pods.last_reviewed, self.owners[1].folder)
        self.assertEqual([owner.calls for owner in self.owners], [[], [], []])

    def test_next_request_reveals_offscreen_review_and_search_does_not_reset_it_later(self):
        self.pods.set_default_size(640, 480)
        self.pods.query.set_text('Beacon')
        self.pods.update()
        settle()
        self.pods.last_reviewed = self.owners[1].folder
        self.pods.focus_next_request()
        settle(.4)
        row = self.pods.rows[self.owners[2].folder]
        self.assertEqual(self.pods.last_reviewed, self.owners[2].folder)
        self.assertTrue(row.approval.details.has_focus())
        found, bounds = row.approval.details.compute_bounds(self.pods.board)
        self.assertTrue(found)
        adjustment = self.pods.board.get_vadjustment()
        self.assertLess(bounds.get_y(), self.pods.board.get_height(),
                        (adjustment.get_value(), adjustment.get_upper(), adjustment.get_page_size(),
                         self.pods.reveal_target, self.pods.reveal_frame))
        self.assertGreater(bounds.get_y() + bounds.get_height(), 0)
        self.assertGreater(self.pods.board.get_vadjustment().get_value(), 0)

    def test_batch_loading_reuses_owner_and_reports_capacity_or_missing_folder_in_pods(self):
        fourth = Workspace('/projects/Delta')
        self.app.workspaces[fourth.folder] = fourth
        self.app.open_workspace = lambda path, on_error=None: Application.open_workspace(self.app, path, on_error)
        with tempfile.TemporaryDirectory() as directory:
            self.pods.projects_chosen([self.owners[0].folder, directory, directory + '/missing'])
        self.assertEqual(len(self.app.workspaces), 4)
        self.assertEqual(self.owners[0].presented, 1)
        self.assertTrue(self.pods.load_error.get_visible())
        self.assertIn('Four projects', self.pods.load_error.get_text())
        self.assertIn('unavailable', self.pods.load_error.get_text())

    def test_replaced_request_requires_explicit_review_and_old_callbacks_cannot_decide_it(self):
        owner = self.owners[0]
        review = self.pods.rows[owner.folder].approval
        before = text_value(review.details)
        owner.runs['one']['approval']['args'] = '{"command":"replacement"}'
        self.pods.update()
        review.allow.emit('clicked')
        self.assertEqual(owner.calls, [])
        self.assertTrue(review.next.get_visible())
        self.assertEqual(text_value(review.details), before)
        review.next.emit('clicked')
        self.assertIn('replacement', text_value(review.details))
        review.allow.emit('clicked')
        review.deny.emit('clicked')
        self.assertEqual(len(owner.calls), 1)
        self.assertFalse(review.allow.get_sensitive())

    def test_workspace_and_pod_share_pending_rejection_and_stop(self):
        owner = self.owners[0]
        workspace_review = ApprovalView(owner)
        workspace_review.update()
        pod_review = self.pods.rows[owner.folder].approval
        workspace_review.allow.emit('clicked')
        pod_review.deny.emit('clicked')
        self.assertEqual(len(owner.calls), 1)
        owner.calls[0][3](RuntimeRejected('Review failed; retry this operation.'))
        self.pods.update()
        self.assertIn('retry', pod_review.message.get_text())
        self.assertTrue(pod_review.allow.get_sensitive())
        self.pods.rows[owner.folder].stop.emit('clicked')
        workspace_review.allow.emit('clicked')
        self.assertEqual([call[0] for call in owner.calls], ['approval.resolve', 'task.cancelAll'])
        self.assertEqual(self.owners[1].calls, [])

    def test_reading_freezes_feed_across_bursts_and_reflow_until_resume(self):
        owner = self.owners[0]
        run = owner.runs['one']
        run['state'] = 'running'
        run['activities'] = [dict(sequence=i, message=f'Activity {i}', detail='Recorded output ' * 100) for i in range(60)]
        self.pods.update()
        settle()
        row = self.pods.rows[owner.folder]
        buffer = row.feed.text.get_buffer()
        buffer.select_range(buffer.get_start_iter(), buffer.get_iter_at_offset(12))
        held = text_value(row.feed.text)
        for i in range(10):
            run['response'] = 'New result ' + str(i)
            self.pods.update()
        self.pods.set_default_size(640, 480)
        settle()
        self.assertEqual(text_value(row.feed.text), held)
        self.assertTrue(buffer.get_has_selection())
        self.assertTrue(row.feed.state.paused)
        row.feed.latest.emit('clicked')
        settle()
        self.assertIn('New result 9', text_value(row.feed.text))
        self.assertFalse(buffer.get_has_selection())
        self.assertFalse(row.feed.state.paused)
        adjustment = row.feed.pane.get_vadjustment()
        self.assertAlmostEqual(adjustment.get_value(), max(0, adjustment.get_upper() - adjustment.get_page_size()), delta=2)

    def test_reopen_same_path_replaces_owner_and_destroy_releases_sources(self):
        old = self.pods.rows[self.owners[0].folder]
        replacement = Workspace(self.owners[0].folder)
        self.app.workspaces[replacement.folder] = replacement
        self.pods.update()
        row = self.pods.rows[replacement.folder]
        self.assertIs(row.workspace, replacement)
        self.assertFalse(old.feed.alive)
        row.stop.emit('clicked')
        self.assertEqual(self.owners[0].calls, [])
        self.assertEqual(len(replacement.calls), 1)
        self.pods.destroy()
        self.assertIsNone(self.app.pods_window)
        self.assertFalse(row.feed.alive)
        self.assertIsNone(row.feed.tail_source)

    def test_layout_long_arguments_and_native_light_dark_at_three_widths(self):
        owner = self.owners[0]
        owner.runs['one']['approval']['args'] = '界' * 12000
        owner.runs['one']['text'] = 'A long instruction ' * 80
        owner.title.get_text = lambda: 'A long conversation title ' * 50
        self.owners[1].runs['one']['state'] = 'running'
        self.owners[1].runs['one']['activities'] = [dict(sequence=i, message=f'Activity {i}', detail='file.py\n' * 100) for i in range(60)]
        self.owners[2].client.closed = True
        self.pods.rows[owner.folder].approval.displayed = None
        settings = Gtk.Settings.get_default()
        original = settings.get_property('gtk-application-prefer-dark-theme')
        observed = []
        try:
            for width, columns, dark in ((1180, 3, False), (820, 2, False), (640, 1, True)):
                settings.set_property('gtk-application-prefer-dark-theme', dark)
                self.pods.set_default_size(width, 780 if width > 640 else 480)
                self.pods.update()
                settle(.3)
                positions = []
                for row in self.pods.rows.values():
                    found, bounds = row.view.compute_bounds(self.pods.list)
                    self.assertTrue(found)
                    positions.append(round(bounds.get_x()))
                    self.assertGreater(row.view.get_width(), 300)
                    if width == 640:
                        self.assertLessEqual(row.view.get_height(), self.pods.board.get_height())
                    self.assertLessEqual(bounds.get_x() + bounds.get_width(), self.pods.list.get_width() + 1)
                    for control in (row.stop, row.open, row.approval.allow, row.approval.deny):
                        if control.get_mapped():
                            found, control_bounds = control.compute_bounds(row.view)
                            self.assertGreaterEqual(control_bounds.get_x(), 0)
                            self.assertLessEqual(control_bounds.get_x() + control_bounds.get_width(), row.view.get_width() + 1)
                observed.append((width, len(set(positions)), columns))
                feed = self.pods.rows[self.owners[1].folder].feed
                adjustment = feed.pane.get_vadjustment()
                self.assertFalse(feed.state.paused)
                self.assertAlmostEqual(adjustment.get_value(), max(0, adjustment.get_upper() - adjustment.get_page_size()), delta=16)
                viewport = feed.text.get_visible_rect()
                _, last_visible = feed.text.get_iter_at_location(viewport.x + viewport.width - 1, viewport.y + viewport.height - 1)
                self.assertLessEqual(feed.text.get_buffer().get_end_iter().get_line() - last_visible.get_line(), 1)
                self.assertLessEqual(self.pods.get_width(), width)
                capture(self.pods, f'pods-{width}')
            self.assertTrue(all(actual == expected for _, actual, expected in observed), observed)
        finally:
            settings.set_property('gtk-application-prefer-dark-theme', original)

    def test_empty_board_and_keyboard_shortcuts(self):
        self.app.workspaces.clear()
        self.pods.update()
        self.assertEqual(self.pods.rows, {})
        self.assertTrue(self.pods.empty_load.get_visible())
        self.assertFalse(self.pods.attention.get_sensitive())
        self.assertTrue(self.pods.key_pressed(None, Gdk.KEY_f, 0, Gdk.ModifierType.CONTROL_MASK))
        self.pods.query.set_text('unmatched')
        self.assertTrue(self.pods.key_pressed(None, Gdk.KEY_Escape, 0, Gdk.ModifierType(0)))
        self.assertEqual(self.pods.query.get_text(), '')


if __name__ == '__main__':
    unittest.main()
