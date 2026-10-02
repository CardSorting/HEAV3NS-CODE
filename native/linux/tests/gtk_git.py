"""Real worker Git setup and conflict review in an isolated temporary repository."""
import os
from pathlib import Path
import subprocess
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
project = root / 'Fresh Git project'
project.mkdir()
(project / 'hello.txt').write_text('First version\n')
app = Application()
errors, requests = [], []
phase, started = 0, time.monotonic()

def git(*args, check=True):
    return subprocess.run(['git', '-C', str(project), *args], check=check, capture_output=True, text=True)

def capture(ws, name):
    directory = os.environ.get('HEAV3NS_SCREENSHOT_DIR')
    if directory:
        import gi
        gi.require_version('GdkX11', '4.0')
        from gi.repository import GdkX11
        subprocess.run(['xwd', '-id', str(ws.get_surface().get_xid()), '-silent', '-out', str(Path(directory) / (name + '.xwd'))], check=True)

def tick():
    global phase, stable_since, read_count, conflict_index
    try:
        assert time.monotonic() - started < 60, f'Git recovery timed out in phase {phase}'
        if phase == 0:
            app.library.set_visible(False)
            app.open_workspace(str(project))
            phase = 1
            return True
        ws = app.workspaces[str(project)]
        assert not ws.client.closed, ws.client.failure
        if not ws.connected_once:
            return True
        browser = ws.task_context.browser
        if phase == 1:
            rpc = ws.rpc
            def tracked(method, *args, **kwargs):
                requests.append(method)
                return rpc(method, *args, **kwargs)
            ws.rpc = tracked
            ws.composer.get_buffer().set_text('Preserve this draft during Git setup.')
            ws.changes()
            phase = 2
        elif phase == 2:
            if browser.loading or not browser.git_problem:
                return True
            assert browser.git_problem.startswith('GIT_NOT_REPOSITORY:'), browser.git_problem
            assert browser.initialize.get_visible() and browser.initialize.get_sensitive()
            assert not browser.error.get_visible()
            assert not (project / '.git').exists()
            stable_since, read_count = time.monotonic(), requests.count('changes.list')
            phase = 3
        elif phase == 3:
            if time.monotonic() - stable_since < 2.5:
                return True
            assert requests.count('changes.list') == read_count, requests
            assert ws.task_context.get_width() <= 720, ws.task_context.get_width()
            assert not ws.inspector.get_visible()
            assert browser.git_description.get_width() <= browser.get_width()
            capture(ws, 'git-wide-setup')
            ws.set_default_size(800, 720)
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', True)
            phase = 4
        elif phase == 4:
            ws.adapt_layout(force=True)
            assert ws.get_width() < 1140
            assert browser.get_width() <= ws.get_width()
            assert browser.git_title.get_mapped()
            capture(ws, 'git-compact-setup')
            browser.initialize.emit('clicked')
            browser.initialize_repository()
            phase = 5
        elif phase == 5:
            if browser.initializing or browser.loading or browser.git_problem:
                return True
            assert requests.count('repository.initialize') == 1, requests
            assert browser.result['branch'] == 'main'
            assert any(e['path'] == 'hello.txt' and e['untracked'] for e in browser.entries)
            assert (project / '.git').is_dir()
            assert subprocess.run(['git', '-C', str(project), 'rev-parse', '--verify', 'HEAD'], capture_output=True).returncode != 0
            subprocess.run(['git', '-C', str(project), 'add', '.'], check=True)
            staged = subprocess.check_output(['git', '-C', str(project), 'ls-files'], text=True)
            assert '.broccolidb' not in staged
            browser.reload()
            phase = 6
        elif phase == 6:
            if browser.loading:
                return True
            browser.scope.set_active_id('staged')
            row = next(row for row in browser.items if row.entry['path'] == 'hello.txt')
            browser.activate(row)
            phase = 7
        elif phase == 7:
            if ws.inspector.loading:
                return True
            assert '+First version' in text_value(ws.inspector.view)
            capture(ws, 'git-compact-diff')
            ws.set_default_size(1440, 860)
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', False)
            ws.task_context.browse.set_active(True)
            phase = 8
        elif phase == 8:
            ws.adapt_layout(force=True)
            capture(ws, 'git-wide-diff')
            assert text_value(ws.composer) == 'Preserve this draft during Git setup.'
            git('config', 'user.name', 'Git UI Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            git('commit', '-qm', 'base')
            git('checkout', '-qb', 'other')
            (project / 'hello.txt').write_text('Other branch\n')
            git('commit', '-qam', 'other')
            git('checkout', '-q', 'main')
            (project / 'hello.txt').write_text('Main branch\n')
            git('commit', '-qam', 'main')
            assert git('merge', 'other', check=False).returncode == 1
            conflict_index = (project / '.git/index').read_bytes()
            browser.scope.set_active_id('conflicts')
            browser.reload()
            phase = 9
        elif phase == 9:
            if browser.loading:
                return True
            assert not browser.git_problem, browser.git_problem
            assert len(list(browser.items)) == 1
            row = browser.items.get_row_at_index(0)
            assert row.entry['conflicted'] and not row.entry['staged']
            assert '1 merge conflict' in browser.message.get_text()
            assert not browser.all_diff.get_visible()
            browser.activate(row)
            phase = 10
        elif phase == 10:
            if ws.inspector.loading:
                return True
            assert '<<<<<<< HEAD' in text_value(ws.inspector.view)
            assert not ws.inspector.staged.get_active()
            assert (project / '.git/index').read_bytes() == conflict_index
            capture(ws, 'git-wide-conflicts')
            ws.set_default_size(800, 720)
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', True)
            ws.task_context.browse.set_active(True)
            phase = 11
        elif phase == 11:
            ws.adapt_layout(force=True)
            assert ws.get_width() < 1140
            assert browser.message.get_width() <= browser.get_width()
            capture(ws, 'git-compact-conflicts')
            assert text_value(ws.composer) == 'Preserve this draft during Git setup.'
            # POSIX permits undecodable names. They must never become a
            # replacement-character path that opens a different file.
            with open(os.fsencode(project) + b'/\xff.txt', 'wb') as stream:
                stream.write(b'invalid UTF-8 name')
            (project / '\ufffd.txt').write_text('different file')
            browser.reload()
            phase = 12
        elif phase == 12:
            if browser.loading:
                return True
            assert browser.git_problem.startswith('GIT_PATH_ENCODING:'), browser.git_problem
            assert not browser.initialize.get_visible()
            assert not browser.all_diff.get_sensitive()
            ws.close()
            app.library.close()
            print('GTK Git recovery passed: stable setup, single explicit initialization, staged diff, runtime-data exclusion, conflict filtering and diff without index changes, compact/wide layouts, preserved draft and safe invalid-filename failure.')
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
