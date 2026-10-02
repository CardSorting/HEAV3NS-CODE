"""Stable transcript rows preserve selection and focus during unrelated updates."""
from gi.repository import Gtk
from .widgets import box, button, clear, label
from .presentation import humanize


def set_text(widget, value):
    if widget.get_text() != value:
        widget.set_text(value)


class RunRow:
    def __init__(self, owner, identity):
        self.owner, self.identity, self.state = owner, identity, None
        self.view = box(spacing=8)
        you = box(spacing=6)
        you.add_css_class('user-message')
        you.append(label('You', 'heading'))
        self.instruction = label('')
        you.append(self.instruction)
        self.view.append(you)
        self.heading = label('', 'heading')
        self.view.append(self.heading)
        self.response = label('')
        self.view.append(self.response)
        self.activity = label('', 'dim-label')
        self.view.append(self.activity)
        self.actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=6)
        self.view.append(self.actions)

    def current(self):
        return self.owner.runs.get(self.identity, {})

    def update(self, run):
        set_text(self.instruction, run.get('text', ''))
        set_text(self.heading, 'LUMI · ' + humanize(run.get('state')))
        set_text(self.response, run.get('response', ''))
        self.response.set_visible(bool(run.get('response')))
        activities = run.get('activities', [])
        set_text(self.activity, activities[-1].get('message', '') if activities else '')
        self.activity.set_visible(bool(activities))
        if self.state == run.get('state'):
            return
        self.state = run.get('state')
        clear(self.actions)
        ws, identity = self.owner, self.identity
        self.actions.append(button('Details', lambda: ws.evidence('Run details', 'history.read', {'run': identity})))
        self.actions.append(button('Walkthrough', lambda: ws.evidence('Walkthrough', 'activity.list', {'run': identity})))
        if self.state in ('completed', 'failed', 'cancelled', 'interrupted'):
            self.actions.append(button('Output', lambda: ws.evidence('Recorded output', 'artifact.read', {'run': identity}, True)))
            if self.state != 'completed' and 'task-continuation-v1' in ws.client.capabilities:
                self.actions.append(button('Continue…', lambda: ws.prepare_continuation(self.current())))
        if self.state == 'queued':
            self.actions.append(button('Edit', lambda: ws.edit_queued(self.current())))
            self.actions.append(button('Remove', lambda: ws.rpc('task.cancel', {'run': identity, 'ifQueued': True}, lambda _: ws.refresh())))
