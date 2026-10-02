"""Real GTK controls and production DesktopSession with a scripted engine."""
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
os.environ['XDG_STATE_HOME'] = str(root / 'state')
os.environ['HOME'] = str(root)
os.environ['DIETCODE_DIR'] = str(root / '.dietcode')
project = root / 'Linux workspace'
project.mkdir()
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


def capture(workspace, name):
    if os.environ.get('HEAV3NS_SCREENSHOT_DIR'):
        import subprocess
        import gi
        gi.require_version('GdkX11', '4.0')
        from gi.repository import GdkX11
        xid = workspace.get_surface().get_xid()
        subprocess.run(['xwd', '-id', str(xid), '-silent', '-out', str(Path(os.environ['HEAV3NS_SCREENSHOT_DIR']) / (name + '.xwd'))], check=True)


def tick():
    global phase
    try:
        assert not errors, errors
        assert time.monotonic() - started < 60, 'GTK execution timed out'
        if phase == 0:
            app.library.set_visible(False)
            app.open_workspace(str(project))
            phase = 1
            return True
        workspace = app.workspaces[str(project)]
        if not workspace.connected_once:
            assert not workspace.client.closed, workspace.client.failure
            return True
        if phase == 1:
            workspace.composer.get_buffer().set_text('Review this project and explain the changes before running checks.')
            assert workspace.send.get_sensitive()
            workspace.send.emit('clicked')
            phase = 2
            return True
        if phase == 2:
            if not workspace.approval_box.get_visible():
                return True
            assert not text_value(workspace.composer)
            assert workspace.stop.get_sensitive()
            workspace.composer.get_buffer().set_text('Then review the saved output.')
            workspace.send.emit('clicked')
            phase = 3
            return True
        if phase == 3:
            if not workspace.queued or workspace.submitting:
                return True
            if not workspace.task_context.walkthrough.rows:
                return True
            assert workspace.send.get_label() == 'Queue'
            next(iter(workspace.task_context.walkthrough.rows.values())).view.set_expanded(True)
            phase = 35
            return True
        if phase == 35:
            capture(workspace, 'linux-wide-approval')
            workspace.sidebar.set_visible(False)
            workspace.set_default_size(760, 680)
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', True)
            phase = 4
            return True
        if phase == 4:
            capture(workspace, 'linux-compact-approval')
            allow = next(w for w in descendants(workspace.approval_box) if isinstance(w, Gtk.Button) and w.get_label() == 'Allow once')
            allow.emit('clicked')
            phase = 5
            return True
        if phase == 5:
            if not any(run['state'] == 'completed' for run in workspace.runs.values()):
                return True
            workspace.stop.emit('clicked')
            phase = 6
            return True
        if phase == 6:
            if workspace.active or workspace.queued:
                return True
            assert any(run['state'] == 'cancelled' for run in workspace.runs.values())
            assert workspace.pending_submission is None
            workspace.close()
            app.library.close()
            print('GTK execution passed: Send, Queue, Allow once, Stop all, persisted acceptance, wide/light and compact/dark controls.')
            return False
    except Exception:
        errors.append(traceback.format_exc())
        print(errors[-1], file=sys.stderr)
        for workspace in list(app.workspaces.values()):
            workspace.close()
        app.quit()
        return False

GLib.timeout_add(350, tick)
app.run([])
sandbox.cleanup()
if errors:
    sys.exit(1)
