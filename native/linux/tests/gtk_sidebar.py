"""Native docked sidebar, real files/Git/app lifecycle, and compact navigation."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from heav3ns_code.app import Application, Panel, text_value
from gi.repository import GLib, Gtk

sandbox = tempfile.TemporaryDirectory()
root = Path(sandbox.name)
os.environ['HOME'] = str(root)
os.environ['XDG_STATE_HOME'] = str(root / 'state')
os.environ['DIETCODE_DIR'] = str(root / 'account')
project = root / 'Sidebar verification'
project.mkdir()
(project / 'src').mkdir()
(project / 'src/main.py').write_text('class Workspace:\n    def open_project(self):\n        return "Ready"\n')
(project / 'index.html').write_text('<title>Sidebar preview</title><h1>Native Linux app preview</h1>')
subprocess.run(['git', 'init', '-q', str(project)], check=True)
subprocess.run(['git', '-C', str(project), 'add', '.'], check=True)
subprocess.run(['git', '-C', str(project), '-c', 'user.name=UI fixture', '-c', 'user.email=ui@example.invalid', 'commit', '-qm', 'Fixture'], check=True)
(project / 'src/main.py').write_text('class Workspace:\n    def open_project(self):\n        return "Staged"\n')
subprocess.run(['git', '-C', str(project), 'add', '.'], check=True)
(project / 'src/main.py').write_text('class Workspace:\n    def open_project(self):\n        return "Working tree"\n')
app = Application()
errors, requests = [], []
phase = 0
started = time.monotonic()
original = sys.excepthook

def hook(kind, value, trace):
    errors.append(str(value))
    original(kind, value, trace)
sys.excepthook = hook

def capture(ws, name):
    directory = os.environ.get('HEAV3NS_SCREENSHOT_DIR')
    if directory:
        import gi
        gi.require_version('GdkX11', '4.0')
        from gi.repository import GdkX11
        subprocess.run(['xwd', '-id', str(ws.get_surface().get_xid()), '-silent', '-out', str(Path(directory) / (name + '.xwd'))], check=True)

def tick():
    global phase, old_view, old_conversation
    try:
        assert not errors, errors
        assert time.monotonic() - started < 85, f'Sidebar GTK timed out in phase {phase}'
        if phase == 0:
            app.library.set_visible(False)
            app.open_workspace(str(project))
            phase = 1
            return True
        ws = app.workspaces[str(project)]
        assert not ws.client.closed, ws.client.failure
        if not ws.connected_once:
            return True
        ctx = ws.task_context
        if phase == 1:
            ws.composer.get_buffer().set_text('Keep this unsent draft while browsing the sidebar.')
            rpc = ws.rpc
            def tracked(method, *args, **kwargs):
                requests.append(method)
                return rpc(method, *args, **kwargs)
            ws.rpc = tracked
            assert ctx.get_visible() and ws.center.get_visible()
            ws.show_context('inspect')
            phase = 2
        elif phase == 2:
            if ctx.browser.loading:
                return True
            assert ctx.browser.loaded
            folder = next(row for row in ctx.browser.items if row.entry.get('path') == 'src')
            ctx.browser.activate(folder)
            phase = 3
        elif phase == 3:
            if ctx.browser.loading:
                return True
            ctx.browser.activate(ctx.browser.items.get_row_at_index(0))
            phase = 4
        elif phase == 4:
            if ws.inspector.loading:
                return True
            assert 'Working tree' in text_value(ws.inspector.view)
            assert ws.inspector.outline.get_visible()
            assert ws.inspector.get_root() is ws
            assert ws.inspector.view.get_height() >= 120, ws.inspector.view.get_height()
            capture(ws, 'sidebar-wide-inspect')
            ws.changes()
            phase = 5
        elif phase == 5:
            if ctx.browser.loading:
                return True
            ctx.browser.scope.set_active_id('staged')
            ctx.browser.activate(ctx.browser.items.get_row_at_index(0))
            phase = 6
        elif phase == 6:
            if ws.inspector.loading:
                return True
            assert '+        return "Staged"' in text_value(ws.inspector.view)
            assert ws.inspector.history.current.arguments()['staged'] is True
            capture(ws, 'sidebar-wide-changes')
            ws.project()
            phase = 7
        elif phase == 7:
            if ctx.project.loading or not ctx.project.loaded or not ctx.project.choices:
                return True
            assert 'project.healing' not in requests, requests
            assert ctx.project.start.get_sensitive()
            ctx.project.start.emit('clicked')
            phase = 8
        elif phase == 8:
            if ctx.project.status.get('state') != 'running':
                return True
            assert ctx.project.stop.get_sensitive()
            assert ctx.project.preview.get_sensitive()
            capture(ws, 'sidebar-wide-run')
            ctx.project.stop.emit('clicked')
            phase = 9
        elif phase == 9:
            if ctx.project.status.get('state') in ('running', 'stopping'):
                return True
            ws.set_default_size(800, 720)
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', True)
            ws.show_context('inspect')
            phase = 10
        elif phase == 10:
            ws.adapt_layout(force=True)
            assert ws.get_width() < 1140, ws.get_width()
            assert ctx.get_visible() and not ws.center.get_visible()
            ctx.inspector.reload()
            phase = 105
        elif phase == 105:
            if ctx.inspector.loading:
                return True
            assert not ctx.browser.get_visible()
            assert ctx.inspector.view.get_height() >= 180, ctx.inspector.view.get_height()
            capture(ws, 'sidebar-compact-inspect')
            ws.show_conversation()
            phase = 11
        elif phase == 11:
            assert ws.center.get_visible() and not ctx.get_visible()
            assert text_value(ws.composer).startswith('Keep this unsent draft')
            capture(ws, 'sidebar-compact-conversation')
            ws.set_default_size(1440, 860)
            ws.show_context('walkthrough')
            old_view, old_conversation = ctx.inspector, ws.conversation
            ws.change_conversation('conversation.create', {})
            phase = 12
        elif phase == 12:
            if ws.switching or ws.conversation == old_conversation:
                return True
            ctx.update()
            assert not old_view.valid_scope()
            assert ctx.inspector is not old_view
            ws.persist()
            saved = app.store.read(ws.key)
            assert saved['layout']['tab'] == 'walkthrough'
            assert saved['drafts'][old_conversation].startswith('Keep this unsent draft')
            assert not any(isinstance(w, Panel) for w in Gtk.Window.list_toplevels())
            ws.close()
            app.library.close()
            print('GTK sidebar passed: docked file navigation, staged diff, real app start/stop, read-only initialization, compact switching, persisted layout/draft and scope reset.')
            return False
        return True
    except Exception:
        errors.append(traceback.format_exc())
        print(errors[-1], file=sys.stderr)
        for ws in list(app.workspaces.values()):
            ws.close()
        app.quit()
        return False

GLib.timeout_add(350, tick)
app.run([])
sandbox.cleanup()
if errors:
    sys.exit(1)
