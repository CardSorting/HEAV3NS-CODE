"""Headless GTK smoke against the real, isolated runtime; no provider calls."""
import os
from pathlib import Path
import sys
import tempfile
import time
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.app import Application, Panel, text_value
from gi.repository import GLib, Gtk

sandbox = tempfile.TemporaryDirectory()
root = Path(sandbox.name)
os.environ['XDG_STATE_HOME'] = str(root / 'state')
os.environ['XDG_CONFIG_HOME'] = str(root / 'config')
os.environ['HOME'] = str(root / 'home')
os.environ['DIETCODE_DIR'] = str(root / 'account')
(root / 'home').mkdir()
project = root / 'Linux project'
project.mkdir()
(project / 'hello.txt').write_text('Linux native file preview 🌙\n')
(project / 'index.html').write_text('<title>Linux native preview</title>')
app = Application()
errors = []
old_hook = sys.excepthook

def hook(kind, value, trace):
    errors.append(str(value))
    old_hook(kind, value, trace)

sys.excepthook = hook
started = time.monotonic()
phase = 0
windows = []
requests = []

def children(widget):
    child = widget.get_first_child()
    while child:
        yield child
        yield from children(child)
        child = child.get_next_sibling()


def tick():
    global phase, windows
    try:
        assert not errors, errors
        if time.monotonic() - started > 60:
            raise AssertionError('GTK smoke timed out')
        if phase == 0:
            app.library.set_visible(False)
            app.open_workspace(str(project))
            phase = 1
            return True
        workspace = app.workspaces[str(project)]
        if not workspace.connected_once:
            if workspace.client and workspace.client.closed:
                raise AssertionError(workspace.client.failure)
            return True
        if phase == 1:
            assert workspace.client.ready
            assert not workspace.send.get_sensitive()
            workspace.composer.get_buffer().set_text('A draft that must survive navigation 🌙')
            assert workspace.send.get_sensitive()
            workspace.persist()
            assert workspace.store.read(workspace.key)['drafts'][workspace.conversation].endswith('🌙')
            rpc = workspace.rpc
            def tracked(method, *args, **kwargs):
                requests.append(method)
                return rpc(method, *args, **kwargs)
            workspace.rpc = tracked
            workspace.models()
            workspace.files()
            workspace.changes()
            workspace.project()
            workspace.checkpoints()
            workspace.memory()
            workspace.check_code()
            workspace.show_tools()
            workspace.evidence('Context', 'context.inspect', {'conversation': workspace.conversation})
            windows = [w for w in Gtk.Window.list_toplevels() if isinstance(w, Panel)]
            assert len(windows) >= 6
            assert workspace.task_context.inspector.get_root() is workspace
            assert workspace.task_context.project.get_root() is workspace
            assert not any(w.get_title() in ('Project changes', 'Run app', 'Context — Inspect') for w in windows)
            phase = 2
            return True
        if phase == 2:
            if workspace.client.pending:
                return True
            assert 'project.healing' not in requests, 'Opening Run app mutated its saved settings'
            for window in windows:
                # Missing Git is a normal response for a newly created project.
                if window.error.get_visible() and window.get_title() not in ('Project changes', 'Checkpoints'):
                    raise AssertionError(window.get_title() + ': ' + window.error.get_text())
                window.destroy()
            workspace.toggle_sidebar()
            workspace.set_default_size(760, 540)
            phase = 3
            return True
        if phase == 3:
            assert text_value(workspace.composer).endswith('🌙')
            workspace.change_conversation('conversation.create', {})
            phase = 4
            return True
        if phase == 4:
            if workspace.switching or workspace.snapshot_pending:
                return True
            assert text_value(workspace.composer) == ''
            # An explicit renderer snapshot is useful for UI QA; it never submits work.
            if os.environ.get('HEAV3NS_SCREENSHOT'):
                import subprocess
                subprocess.run(['xwd', '-root', '-silent', '-out', os.environ['HEAV3NS_SCREENSHOT']], check=True)
            workspace.close()
            if app.library:
                app.library.close()
            print('GTK smoke passed: real runtime, native panels, drafts, compact layout, conversation switch and shutdown.')
            return False
    except Exception:
        errors.append(traceback.format_exc())
        print(errors[-1], file=sys.stderr)
        for workspace in list(app.workspaces.values()):
            workspace.close()
        app.quit()
        return False

GLib.timeout_add(250, tick)
app.run([])
sandbox.cleanup()
if errors:
    sys.exit(1)
