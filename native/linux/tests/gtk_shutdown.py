"""SIGTERM persists the draft, reaps the worker and releases project ownership."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

if len(sys.argv) > 1 and sys.argv[1] == '--child':
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from heav3ns_code.app import main, text_value
    from gi.repository import Gio, GLib
    project, stage = Path(sys.argv[2]), sys.argv[3]
    started = time.monotonic()
    def tick():
        app = Gio.Application.get_default()
        if time.monotonic() - started > 25:
            print('SIGTERM verification: worker did not reconnect', file=sys.stderr)
            os._exit(2)
        if not app or not app.workspaces:
            return True
        ws = app.workspaces[str(project)]
        if stage == 'blocked':
            if not ws.client.closed or not ws.connection_details.get_visible():
                return True
            assert 'WORKSPACE_OWNED:' in ws.client.failure, ws.client.failure
            assert not ws.send.get_sensitive()
            ws.connection_details.emit('clicked')
            panel = next(panel for panel in ws.panels if panel.get_title() == 'Connection details')
            details = panel.body.get_first_child().get_child()
            assert 'WORKSPACE_OWNED:' in text_value(details)
            os.kill(os.getpid(), signal.SIGTERM)
            return False
        if not ws.connected_once:
            return True
        if stage == 'write':
            ws.composer.get_buffer().set_text('Unsent draft survives SIGTERM.')
        elif text_value(ws.composer) != 'Unsent draft survives SIGTERM.':
            print('SIGTERM verification: draft was not retained', file=sys.stderr)
            os._exit(3)
        os.kill(os.getpid(), signal.SIGTERM)
        return False
    GLib.timeout_add(150, tick)
    sys.argv = ['heav3ns-code', str(project)]
    sys.exit(main())

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    project = root / 'Project'
    project.mkdir()
    key = hashlib.sha256(str(project).encode()).hexdigest()
    env = {**os.environ, 'HOME': str(root), 'XDG_STATE_HOME': str(root / 'state'), 'DIETCODE_DIR': str(root / 'account')}
    owner = root / '.heav3ns/owners' / key
    owner.mkdir(parents=True)
    record = json.dumps({'pid': 999999, 'token': 'fixture', 'startedAt': '2000-01-01', 'workspace': str(project)})
    (owner / 'owner.json').write_text(record)
    subprocess.run([sys.executable, __file__, '--child', str(project), 'blocked'], env=env, check=True, timeout=40)
    assert (owner / 'owner.json').read_text() == record, 'An ambiguous owner must never be stolen'
    owner.rename(root / 'preserved-test-owner')
    for stage in ('write', 'reopen'):
        subprocess.run([sys.executable, __file__, '--child', str(project), stage], env=env, check=True, timeout=40)
        assert not (root / '.heav3ns/owners' / key).exists(), 'Owner lock survived graceful termination'
    state = json.loads((root / 'state/heav3ns-code' / (key + '.json')).read_text())
    assert 'Unsent draft survives SIGTERM.' in state['drafts'].values()
print('GTK shutdown passed: visible startup diagnosis, preserved ambiguous owner, SIGTERM, persisted draft, worker cleanup, ownership release and reconnect.')
