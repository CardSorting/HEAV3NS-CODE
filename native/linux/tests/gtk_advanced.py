"""Real GTK navigation and multi-workspace decisions using the scripted engine."""
import os
from pathlib import Path
import sys
import tempfile
import time
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.app import Application, text_value
from gi.repository import GLib, Gtk

sandbox = tempfile.TemporaryDirectory()
root = Path(sandbox.name)
os.environ['HOME'] = str(root)
os.environ['XDG_STATE_HOME'] = str(root / 'state')
os.environ['DIETCODE_DIR'] = str(root / 'account')
projects = [root / 'Atlas workspace', root / 'Beacon workspace']
for project in projects:
    project.mkdir()
    (project / 'navigation.py').write_text('class Workspace:\n    def open_project(self):\n        return "Ready for review"\n')
app = Application()
errors = []
phase = 0
started = time.monotonic()
original = sys.excepthook

def hook(kind, value, trace):
    errors.append(str(value))
    original(kind, value, trace)

sys.excepthook = hook

def descendants(widget):
    child = widget.get_first_child()
    while child:
        yield child
        yield from descendants(child)
        child = child.get_next_sibling()

def capture(window, name):
    directory = os.environ.get('HEAV3NS_SCREENSHOT_DIR')
    if directory:
        import subprocess
        import gi
        gi.require_version('GdkX11', '4.0')
        from gi.repository import GdkX11
        subprocess.run(['xwd', '-id', str(window.get_native().get_surface().get_xid()), '-silent', '-out', str(Path(directory) / (name + '.xwd'))], check=True)

def finish():
    if app.pods_window:
        app.pods_window.close()
    for ws in list(app.workspaces.values()):
        ws.close()
    app.library.close()

def tick():
    global phase, old_inspector, selection_row, first_conversation, allow, recovery_project, recovery
    try:
        assert not errors, errors
        assert time.monotonic() - started < 75, f'Advanced GTK test timed out in phase {phase}'
        if phase == 0:
            app.library.set_visible(False)
            for project in projects:
                app.open_workspace(str(project))
            phase = 1
            return True
        first, second = [app.workspaces[str(project)] for project in projects]
        for ws in (first, second):
            assert not ws.client.closed, ws.client.failure
            if not ws.connected_once:
                return True
        if phase == 1:
            first.show_tools()
            phase = 2
        elif phase == 2:
            capture(first.palette, 'linux-actions')
            first.palette.query.set_text('open file')
            first.palette.populate()
            first.palette.query.emit('activate')
            assert first.quick_open is not None
            first.quick_open.query.set_text('navigation')
            phase = 3
        elif phase == 3:
            picker = first.quick_open
            if picker.searching or picker.timer or not picker.items.get_selected_row():
                return True
            assert picker.items.get_selected_row().identity == 'navigation.py'
            picker.query.emit('activate')
            phase = 4
        elif phase == 4:
            inspector = first.inspector
            if inspector.loading:
                return True
            assert 'class Workspace' in text_value(inspector.view)
            assert inspector.outline.get_visible()
            inspector.focus_find()
            inspector.search.set_text('Ready')
            inspector.find(reset=True)
            assert inspector.view.get_buffer().get_selection_bounds()
            phase = 5
        elif phase == 5:
            capture(first.inspector, 'linux-inspector')
            first.evidence('Saved state', 'state.inspect', {'conversation': first.conversation})
            phase = 6
        elif phase == 6:
            if first.inspector.loading:
                return True
            assert first.inspector.back.get_sensitive()
            first.inspector.travel(-1)
            phase = 7
        elif phase == 7:
            if first.inspector.loading:
                return True
            assert 'class Workspace' in text_value(first.inspector.view)
            old_inspector = first.inspector
            first_conversation = first.conversation
            first.change_conversation('conversation.create', {})
            phase = 8
        elif phase == 8:
            if first.switching or first.snapshot_pending:
                return True
            assert first.conversation != first_conversation
            assert not old_inspector.valid_scope()
            assert not old_inspector.body.get_sensitive()
            old_inspector.destroy()
            for ws in (first, second):
                ws.composer.get_buffer().set_text('Review this workspace and ask before executing checks.')
                ws.send.emit('clicked')
            app.show_pods()
            phase = 9
        elif phase == 9:
            if not all(ws.approval_box.get_visible() for ws in (first, second)):
                return True
            app.pods_window.update()
            assert len(app.pods_window.rows) == 2
            first.evidence('Walkthrough', 'activity.list', {'run': first.active})
            assert first.task_context.selected == 'walkthrough'
            assert first.task_context.walkthrough.selected == first.active
            row = app.pods_window.rows[first.folder]
            allow = next(w for w in descendants(row.review) if isinstance(w, Gtk.Button) and w.get_label() == 'Allow once')
            selection_row = first.transcript_rows[first.active]
            selection_row.instruction.select_region(0, 6)
            phase = 95
        elif phase == 95:
            capture(app.pods_window, 'linux-pods')
            allow.emit('clicked')
            phase = 10
        elif phase == 10:
            if first.active:
                return True
            assert any(run['state'] == 'completed' for run in first.runs.values())
            assert second.approval_box.get_visible(), 'A Pods decision affected the wrong workspace'
            assert selection_row is first.transcript_rows[selection_row.identity]
            assert selection_row.instruction.get_selection_bounds(), 'Progress discarded transcript selection'
            app.pods_window.update()
            app.pods_window.rows[second.folder].stop.emit('clicked')
            phase = 11
        elif phase == 11:
            if second.active:
                return True
            assert any(run['state'] == 'cancelled' for run in second.runs.values())
            app.pods_window.query.set_text('Beacon')
            app.pods_window.update()
            assert not app.pods_window.rows[first.folder].view.get_visible()
            assert app.pods_window.rows[second.folder].view.get_visible()
            recovery_project = root / 'Recovery workspace'
            recovery_project.mkdir()
            key = app.store.workspace_key(str(recovery_project))
            app.store.path(key).write_text('{"pending": {"id": "uncertain-receipt"}}')
            app.open_workspace(str(recovery_project))
            phase = 12
        elif phase == 12:
            ws = app.workspaces[str(recovery_project)]
            if not ws.connected_once:
                return True
            ws.composer.get_buffer().set_text('Preserve this draft during recovery.')
            assert not ws.send.get_sensitive(), 'Corrupt receipt permitted another submission'
            assert ws.state_recovery.get_visible()
            ws.state_recovery.emit('clicked')
            recovery = next(w for w in Gtk.Window.list_toplevels() if w.get_title() == 'Review saved desktop state')
            phase = 13
        elif phase == 13:
            archive = next(w for w in descendants(recovery) if isinstance(w, Gtk.Button) and w.get_label() == 'Archive original and reset desktop state')
            archive.emit('clicked')
            ws = app.workspaces[str(recovery_project)]
            assert ws.send.get_sensitive()
            backups = list(app.store.root.glob(ws.key + '.recovery-*.json'))
            assert len(backups) == 1 and 'uncertain-receipt' in backups[0].read_text()
            assert app.store.read(ws.key)['drafts'][ws.conversation] == 'Preserve this draft during recovery.'
            finish()
            print('GTK advanced passed: keyboard picker, quick open, find/outline, fresh history, scoped panels, Pods approval/stop isolation, stable transcript selection, explicit state recovery with preserved receipt.')
            return False
        return True
    except Exception:
        errors.append(traceback.format_exc())
        print(errors[-1], file=sys.stderr)
        finish()
        app.quit()
        return False

GLib.timeout_add(350, tick)
app.run([])
sandbox.cleanup()
if errors:
    sys.exit(1)
