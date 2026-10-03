"""One admission point for controls shared by a workspace and its pod."""
import json
from .transport import RuntimeRejected


def ready(owner):
    client = owner.client
    return bool(client and client.ready and not client.closed and owner.connected_once
                and not owner.closed and not owner.switching)


def current_approval(owner):
    run = owner.runs.get(getattr(owner, 'active', None), {})
    approval = run.get('approval')
    if run.get('state') == 'awaiting_approval' and approval and not approval.get('decision'):
        return run
    return None


def approval_identity(owner):
    run = current_approval(owner)
    if run:
        # Bind what was reviewed, including the exact arguments, to its worker.
        return (id(owner.client), owner.conversation, run['id'],
                json.dumps(run['approval'], sort_keys=True, ensure_ascii=False))
    return None


class WorkspaceCommands:
    def __init__(self, owner):
        self.owner = owner
        self.scope = None
        self.approval_pending = None
        self.approval_error = ''
        self.approval_key = None
        self.stop_pending = False
        self.stop_error = ''
        self.stop_generation = 0
        self.stop_work = None

    def sync(self):
        owner = self.owner
        scope = (id(owner.client), owner.conversation)
        if self.scope != scope:
            self.scope = scope
            self.approval_pending = None
            self.approval_error = self.stop_error = ''
            self.stop_pending = False
            self.stop_generation += 1
        key = approval_identity(owner)
        if key != self.approval_key:
            self.approval_key = key
            self.approval_pending = None
            self.approval_error = ''
        work = (getattr(owner, 'active', None), tuple(getattr(owner, 'queued', [])))
        if self.stop_error and work != self.stop_work:
            self.stop_error = ''
        if not any(work) and self.stop_pending:
            self.stop_pending = False
            self.stop_generation += 1

    def can_decide(self, expected):
        self.sync()
        return bool(expected and expected == self.approval_key and ready(self.owner)
                    and 'approval' in self.owner.client.capabilities
                    and not self.approval_pending and not self.stop_pending)

    def decide(self, expected, decision):
        if decision not in ('allow', 'deny') or not self.can_decide(expected):
            return False
        owner = self.owner
        run = current_approval(owner)
        self.approval_pending = expected
        self.approval_error = ''
        def delivered(value, failed=False):
            self.sync()
            if owner.closed or self.approval_key != expected:
                return
            if failed:
                # Only an explicit rejection permits retry. An uncertain mutation
                # remains blocked until a new connection recovers recorded state.
                if isinstance(value, RuntimeRejected):
                    self.approval_pending = None
                self.approval_error = str(value)
                owner.show_error(value)
            else:
                owner.refresh()
            owner.update_controls()
        owner.rpc('approval.resolve', {'run': run['id'], 'operation': run['approval']['operation'], 'decision': decision},
                  delivered, lambda error: delivered(error, True))
        owner.update_controls()
        return True

    def can_stop(self):
        self.sync()
        return bool(ready(self.owner) and 'cancel' in self.owner.client.capabilities
                    and (getattr(self.owner, 'active', None) or getattr(self.owner, 'queued', []))
                    and not self.stop_pending)

    def stop(self):
        if not self.can_stop():
            return False
        owner, scope = self.owner, self.scope
        self.stop_pending, self.stop_error = True, ''
        self.stop_work = (getattr(owner, 'active', None), tuple(getattr(owner, 'queued', [])))
        self.stop_generation += 1
        generation = self.stop_generation
        def delivered(value, failed=False):
            self.sync()
            if owner.closed or self.scope != scope or self.stop_generation != generation:
                return
            if failed:
                if isinstance(value, RuntimeRejected):
                    self.stop_pending = False
                self.stop_error = str(value)
                owner.show_error(value)
            else:
                owner.refresh()
            owner.update_controls()
        owner.rpc('task.cancelAll', {}, delivered, lambda error: delivered(error, True))
        owner.update_controls()
        return True

    def can_reconnect(self):
        owner = self.owner
        return not owner.closed and (owner.client is None or
               owner.client.closed and owner.client.process.poll() is not None)

    def reconnect(self):
        if self.can_reconnect():
            self.owner.connect_runtime()

    def can_checkpoints(self):
        return ready(self.owner) and 'checkpoints-v1' in self.owner.client.capabilities

    def checkpoints(self):
        if self.can_checkpoints():
            self.owner.checkpoints()
