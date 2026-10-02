"""Live recorded activity; expanding or following an instruction never runs it."""
import time
from gi.repository import Gtk, Pango
from .navigation import matches, safe_file, elapsed
from .presentation import humanize
from .widgets import EmbeddedPanel, box, button, clear, icon_button, label, scroll, text_view, text_value
from .transcript import set_text


class ActivityRow:
    def __init__(self, owner, event):
        self.owner, self.event = owner, event
        self.view = Gtk.Expander()
        self.heading = label('')
        self.heading.set_wrap(False)
        self.heading.set_ellipsize(Pango.EllipsizeMode.END)
        self.heading.set_selectable(False)
        self.view.set_label_widget(self.heading)
        body = box(spacing=6, margin=8)
        self.detail = label('')
        body.append(self.detail)
        self.preview = text_view(monospace=True)
        self.preview_scroll = scroll(self.preview, False)
        self.preview_scroll.set_min_content_height(96)
        self.preview_scroll.set_max_content_height(150)
        body.append(self.preview_scroll)
        actions = box(False, spacing=6)
        self.copy = button('Copy excerpt', lambda: self.preview.get_clipboard().set(text_value(self.preview)))
        self.follow = button('Show latest output', self.resume)
        actions.append(self.copy)
        actions.append(self.follow)
        body.append(actions)
        self.links = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=2)
        body.append(self.links)
        self.view.set_child(body)
        self.files = None
        self.update(event)
        self.view.set_expanded(event.get('status') in ('failed', 'denied'))

    def resume(self):
        self.preview.get_buffer().set_text(self.event.get('preview', {}).get('text', ''))
        self.follow.set_visible(False)
        self.preview.scroll_to_iter(self.preview.get_buffer().get_end_iter(), 0, False, 0, 0)

    def update(self, event):
        self.event = event
        set_text(self.heading, humanize(event.get('status')) + ' · ' + event.get('message', 'Activity'))
        self.heading.set_tooltip_text(self.heading.get_text())
        set_text(self.detail, event.get('detail') or 'No additional detail was recorded.')
        preview = event.get('preview', {})
        self.preview_scroll.set_visible(bool(preview))
        self.copy.set_visible(bool(preview))
        new_text = preview.get('text', '')
        changed = new_text != text_value(self.preview)
        adjustment = self.preview_scroll.get_vadjustment()
        reading = bool(self.preview.get_buffer().get_selection_bounds()) or adjustment.get_value() < adjustment.get_upper() - adjustment.get_page_size() - 12
        if changed and reading:
            self.follow.set_visible(True)
        else:
            if changed:
                self.preview.get_buffer().set_text(new_text)
            self.follow.set_visible(False)
        self.copy.set_tooltip_text('Copies the displayed excerpt; it may be limited or held while you read.')
        files = tuple(path for path in event.get('metadata', {}).get('files', []) if safe_file(path))[:3]
        if files != self.files:
            self.files = files
            clear(self.links)
            for path in files:
                self.links.append(button(path.rsplit('/', 1)[-1], lambda value=path: self.owner.evidence(value, 'files.read', {'path': value}, True)))


class Walkthrough(EmbeddedPanel):
    def __init__(self, owner):
        super().__init__(owner, 'Walkthrough')
        self.selected = None
        self.signature = None
        self.loaded_signature = None
        self.loading = False
        self.last_read = 0
        self.rows = {}
        self.run_choices = None
        self.stage = label('Ready when you are', 'title-3')
        self.body.append(self.stage)
        self.instruction = label('Send an instruction to follow its recorded activity here.', 'dim-label')
        self.instruction.set_lines(3)
        self.instruction.set_ellipsize(Pango.EllipsizeMode.END)
        self.body.append(self.instruction)
        selector = box(False, spacing=6)
        self.runs = Gtk.ComboBoxText(hexpand=True)
        for cell in self.runs.get_cells():
            cell.set_property('ellipsize', Pango.EllipsizeMode.END)
            cell.set_property('max-width-chars', 24)
        self.runs.append('follow', 'Follow current instruction')
        self.runs.set_active_id('follow')
        self.runs.connect('changed', self.select)
        selector.append(self.runs)
        selector.append(icon_button('view-refresh-symbolic', 'Reload recorded activity', self.reload))
        self.body.append(selector)
        filters = box(False, spacing=6)
        self.query = Gtk.SearchEntry(placeholder_text='Filter activity…', hexpand=True)
        self.query.connect('changed', lambda *_: self.filter_rows())
        filters.append(self.query)
        self.kind = Gtk.ComboBoxText()
        for key, title in [('all', 'All activity'), ('tool', 'Actions'), ('draft', 'Drafts'), ('issue', 'Issues')]:
            self.kind.append(key, title)
        self.kind.set_active_id('all')
        self.kind.connect('changed', lambda *_: self.filter_rows())
        filters.append(self.kind)
        self.body.append(filters)
        self.activities = box(spacing=8)
        self.reader = scroll(self.activities)
        self.body.append(self.reader)
        self.coverage = label('No activity recorded yet.', 'dim-label')
        self.body.append(self.coverage)
        self.empty = label('Activity appears here as LUMI works. Files, changes and app controls are available in the other tabs.', 'dim-label')
        self.body.append(self.empty)
        actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=3)
        self.details = button('Run details', self.open_details)
        self.changes = button('Changes', owner.changes)
        self.review = button('Review approval', owner.review_approval)
        self.resume = button('Continue…', self.continue_run)
        self.latest = button('Latest activity', self.to_latest)
        for widget in (self.details, self.changes, self.review, self.resume, self.latest):
            actions.append(widget)
        self.body.append(actions)

    def select(self, *_):
        self.gate.issue('activity')
        self.loading, self.loaded_signature = False, None
        self.update()

    def pin(self, identity):
        run = self.owner.runs.get(identity)
        if run:
            if identity not in dict(self.run_choices or ()):
                self.runs.append(identity, run.get('text', 'Instruction')[:70])
            self.runs.set_active_id(identity)

    def update(self):
        ws = self.owner
        ordered = sorted(ws.runs.values(), key=lambda run: (run.get('createdAt', 0), run['id']), reverse=True)
        recent = ordered[:50]
        pinned = ws.runs.get(self.runs.get_active_id())
        if pinned and pinned not in recent:
            recent.append(pinned)
        choices = tuple((run['id'], run.get('text', '')[:70]) for run in recent)
        if choices != self.run_choices:
            selected = self.runs.get_active_id()
            self.runs.handler_block_by_func(self.select)
            self.runs.remove_all()
            self.runs.append('follow', 'Follow current instruction')
            for identity, title in choices:
                self.runs.append(identity, title)
            self.runs.set_active_id(selected if selected in dict(choices) else 'follow')
            self.runs.handler_unblock_by_func(self.select)
            self.run_choices = choices
        identity = self.runs.get_active_id()
        run = ws.runs.get(identity) if identity != 'follow' else ws.runs.get(getattr(ws, 'active', None)) or (ordered[0] if ordered else None)
        run = run or {}
        if self.selected != run.get('id'):
            self.gate.issue('activity')
            self.selected = run.get('id')
            self.loading, self.loaded_signature = False, None
            clear(self.activities)
            self.rows.clear()
            self.query.set_text('')
            self.kind.set_active_id('all')
            self.error.set_visible(False)
        ready = bool(ws.client and ws.client.ready and not ws.client.closed and not ws.switching)
        set_text(self.stage, (humanize(run.get('state')) + ' · ' + elapsed(run, time.time())) if run else 'Ready when you are')
        if not ready and run:
            set_text(self.stage, 'Disconnected · last confirmed state')
        set_text(self.instruction, run.get('text', 'Send an instruction to follow its recorded activity here.'))
        self.instruction.set_tooltip_text(self.instruction.get_text())
        self.signature = (self.selected, run.get('revision'), run.get('activitySequence'), run.get('state'))
        self.details.set_sensitive(ready and bool(run))
        self.review.set_visible(run.get('state') == 'awaiting_approval')
        self.review.set_sensitive(ready)
        self.resume.set_visible(run.get('state') in ('interrupted', 'cancelled', 'failed'))
        self.resume.set_sensitive(ready and 'task-continuation-v1' in (ws.client.capabilities if ws.client else set()) and not getattr(ws, 'active', None) and not getattr(ws, 'queued', []))
        self.changes.set_sensitive(ready and 'changes' in (ws.client.capabilities if ws.client else set()))
        if not run:
            self.coverage.set_text('No activity recorded yet.')
            self.empty.set_visible(True)
        if ready and self.get_mapped() and self.selected and not self.loading and self.signature != self.loaded_signature and time.monotonic() - self.last_read > 1:
            self.reload()

    def reload(self):
        if not self.selected or self.loading:
            return
        self.loading, self.last_read = True, time.monotonic()
        identity, signature = self.selected, self.signature
        def loaded(result):
            self.loading = False
            self.loaded_signature = signature
            events = result.get('activities', [])
            keep = {event['activityId'] for event in events}
            for key in set(self.rows) - keep:
                self.activities.remove(self.rows.pop(key).view)
            for event in events:
                key = event['activityId']
                if key not in self.rows:
                    self.rows[key] = ActivityRow(self.owner, event)
                    self.activities.append(self.rows[key].view)
                else:
                    self.rows[key].update(event)
            self.coverage.set_text(f"{len(events)} retained of {result.get('activityCount', len(events))} recorded activities")
            self.filter_rows()
        def failed(error):
            self.loading = False
            self.loaded_signature = signature
            self.show_error(str(error) + ' Use Reload to try again.')
        self.request('activity.list', {'run': identity}, loaded, failed, lane='activity')

    def filter_rows(self):
        count = 0
        for row in self.rows.values():
            event = row.event
            kind = self.kind.get_active_id()
            show = matches(self.query.get_text(), event.get('message', ''), event.get('detail', ''))
            show = show and (kind == 'all' or kind == 'issue' and event.get('status') in ('failed', 'denied', 'cancelled') or kind == 'tool' and event.get('phase') in ('tool', 'writing', 'verifying') or kind == 'draft' and event.get('preview', {}).get('kind') == 'draft')
            row.view.set_visible(show)
            count += int(show)
        self.empty.set_visible(not count)
        self.empty.set_text('No activity matches these filters.' if self.rows else 'No retained activity yet. Use Run details to review the recorded outcome.')

    def to_latest(self):
        self.reader.get_vadjustment().set_value(self.reader.get_vadjustment().get_upper())

    def open_details(self):
        if self.selected:
            self.owner.evidence('Run details', 'history.read', {'run': self.selected})

    def continue_run(self):
        run = self.owner.runs.get(self.selected)
        if self.valid_scope() and run and self.resume.get_sensitive():
            self.owner.prepare_continuation(run)
            self.owner.show_conversation()
