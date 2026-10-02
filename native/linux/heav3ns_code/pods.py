"""A live overview of already-owned workspaces. Never spawns another worker."""
import time
from gi.repository import GLib, Gtk, Pango
from .navigation import matches, elapsed
from .presentation import humanize
from .widgets import box, button, clear, label, scroll, text_view


class PodRow:
    def __init__(self, workspace):
        self.workspace = workspace
        self.view = box(margin=16)
        top = box(False)
        self.name = label(workspace.folder.rsplit('/', 1)[-1], 'title-3')
        self.name.set_hexpand(True)
        self.name.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        self.name.set_wrap(False)
        top.append(self.name)
        top.append(button('Open workspace', workspace.present))
        self.view.append(top)
        path = label(workspace.folder, 'dim-label')
        path.set_wrap(False)
        path.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        path.set_tooltip_text(workspace.folder)
        self.view.append(path)
        self.status = label('Connecting…', 'heading')
        self.view.append(self.status)
        self.instruction = label('')
        self.instruction.set_lines(2)
        self.instruction.set_ellipsize(Pango.EllipsizeMode.END)
        self.view.append(self.instruction)
        self.activity = label('', 'dim-label')
        self.activity.set_lines(2)
        self.activity.set_ellipsize(Pango.EllipsizeMode.END)
        self.view.append(self.activity)
        self.review = box()
        self.view.append(self.review)
        self.approval_key = None
        actions = box(False)
        self.stop = button('Stop project work', lambda: workspace.rpc('task.cancelAll', {}, lambda _: workspace.refresh()))
        actions.append(self.stop)
        self.reconnect = button('Reconnect', workspace.connect_runtime)
        actions.append(self.reconnect)
        self.view.append(actions)
        self.view.append(Gtk.Separator())

    def update(self):
        ws = self.workspace
        ready = bool(ws.client and ws.client.ready and not ws.client.closed and ws.connected_once)
        run = ws.runs.get(getattr(ws, 'active', None)) or max(ws.runs.values(), key=lambda item: item.get('createdAt', 0), default={})
        queued = len(getattr(ws, 'queued', []))
        status = humanize(run.get('state')) if run else 'Ready'
        self.status.set_text((f'{status} · {elapsed(run, time.time())} · {queued} queued' if run else 'Ready · No instructions yet') if ready else 'Disconnected · last confirmed state')
        self.instruction.set_text(run.get('text', 'Start a conversation in this workspace.'))
        self.instruction.set_tooltip_text(run.get('text', ''))
        activities = run.get('activities', [])
        self.activity.set_text(activities[-1].get('message', '') if activities else '')
        self.stop.set_sensitive(ready and bool(getattr(ws, 'active', None) or queued))
        self.reconnect.set_visible(not ready)
        self.reconnect.set_sensitive(bool(ws.client and ws.client.closed and ws.client.process.poll() is not None))
        approval = run.get('approval') if run.get('state') == 'awaiting_approval' else None
        identity = (id(ws.client), ws.conversation, run.get('id'), approval.get('operation')) if approval else None
        if identity != self.approval_key:
            self.approval_key = identity
            clear(self.review)
            if approval:
                self.review.append(label(approval.get('reason', 'Review this operation'), 'heading'))
                self.review.append(label(f"{approval.get('tool', '')} · {approval.get('scope', '')}", 'dim-label'))
                details = text_view(monospace=True)
                details.get_buffer().set_text(approval.get('args', ''))
                pane = scroll(details, False)
                pane.set_min_content_height(70)
                pane.set_max_content_height(120)
                self.review.append(pane)
                choices = box(False)
                def decide(decision, expected=identity, selected=run['id'], operation=approval['operation']):
                    current = ws.runs.get(selected, {})
                    actual = (id(ws.client), ws.conversation, selected, current.get('approval', {}).get('operation'))
                    if actual != expected or current.get('state') != 'awaiting_approval' or not ws.client.ready or ws.client.closed:
                        ws.show_error('This approval is no longer current. Review the latest workspace state.')
                        return
                    choices.set_sensitive(False)
                    ws.rpc('approval.resolve', {'run': selected, 'operation': operation, 'decision': decision},
                           lambda _: ws.refresh(), lambda error: (ws.show_error(error), choices.set_sensitive(True)))
                choices.append(button('Deny', lambda: decide('deny')))
                choices.append(button('Allow once', lambda: decide('allow'), 'suggested-action'))
                self.review.append(choices)
        self.review.set_sensitive(ready)


class Pods(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title='Pods — Open projects', default_width=940, default_height=720)
        self.app, self.rows = app, {}
        body = box(margin=20)
        body.append(label('Open projects', 'title-1'))
        body.append(label('Observe current work and review decisions across your workspace windows.', 'dim-label'))
        self.query = Gtk.SearchEntry(placeholder_text='Filter open projects…')
        self.query.connect('search-changed', lambda *_: self.update())
        body.append(self.query)
        self.list = box()
        body.append(scroll(self.list))
        self.empty = label('Open a project to see its work here.', 'dim-label')
        body.append(self.empty)
        self.set_child(body)
        self.timer = GLib.timeout_add(500, self.update)
        self.connect('close-request', self.closed)
        self.update()
        self.present()
        self.query.grab_focus()

    def closed(self, *_):
        GLib.source_remove(self.timer)
        self.app.pods_window = None
        return False

    def update(self):
        for path in set(self.rows) - set(self.app.workspaces):
            self.list.remove(self.rows.pop(path).view)
        visible = 0
        for path, workspace in self.app.workspaces.items():
            if path not in self.rows:
                row = PodRow(workspace)
                self.rows[path] = row
                self.list.append(row.view)
            row = self.rows[path]
            show = matches(self.query.get_text(), path, workspace.title.get_text())
            row.view.set_visible(show)
            if show:
                visible += 1
                row.update()
        self.empty.set_visible(not visible)
        self.empty.set_text('No open projects match your filter.' if self.app.workspaces else 'Open a project to see its work here.')
        return True
