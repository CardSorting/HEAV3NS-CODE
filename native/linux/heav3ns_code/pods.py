"""Native control room over existing workspace owners; no extra workers or polling RPCs."""
import time
from pathlib import Path
from gi.repository import Gdk, GLib, Gtk, Pango
from .approval import ApprovalView
from .pod_model import FeedState, includes, snapshot, stream_text
from .widgets import box, button, label, scroll, text_view


def line(text='', style=None):
    widget = label(text, style)
    widget.set_wrap(False)
    widget.set_ellipsize(Pango.EllipsizeMode.END)
    widget.set_max_width_chars(1)
    widget.set_hexpand(True)
    return widget


def update_label(widget, text):
    if widget.get_text() != text:
        widget.set_text(text)
        widget.set_tooltip_text(text)


class PodFeed:
    def __init__(self):
        self.state = FeedState()
        self.alive, self.anchoring, self.dragging = True, False, False
        self.tail_source = None
        self.live = False
        self.view = box(spacing=6)
        header = box(False, spacing=6)
        self.heading = line('Recorded activity', 'dim-label')
        self.pause = button('Pause', self.hold)
        self.pause.set_tooltip_text('Pause this feed. Agent work and approval requests continue updating.')
        self.latest = button('Latest', self.resume)
        for control in (self.heading, self.pause, self.latest):
            header.append(control)
        self.view.append(header)
        self.text = text_view()
        self.text.update_property([Gtk.AccessibleProperty.LABEL], ['Agent activity stream'])
        self.tail_mark = self.text.get_buffer().create_mark(None, self.text.get_buffer().get_end_iter(), False)
        self.pane = scroll(self.text)
        self.pane.set_min_content_height(140)
        self.pane.add_css_class('frame')
        self.view.append(self.pane)
        self.text.get_buffer().connect('notify::has-selection', self.selection_changed)
        adjustment = self.pane.get_vadjustment()
        adjustment.connect('changed', lambda *_: self.schedule_tail())
        adjustment.connect('value-changed', self.scrolled)
        wheel = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.VERTICAL)
        wheel.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        wheel.connect('scroll', self.wheel)
        self.pane.add_controller(wheel)
        keys = Gtk.EventControllerKey()
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        keys.connect('key-pressed', self.key_pressed)
        self.text.add_controller(keys)
        drag = Gtk.GestureClick(button=0)
        drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        drag.connect('pressed', lambda *_: setattr(self, 'dragging', True))
        drag.connect('released', lambda *_: setattr(self, 'dragging', False))
        drag.connect('stopped', lambda *_: setattr(self, 'dragging', False))
        self.pane.add_controller(drag)

    def selection_changed(self, *_):
        if self.text.get_buffer().get_has_selection():
            self.hold()

    def wheel(self, controller, dx, dy):
        if dy < 0:
            self.hold()
        return False

    def key_pressed(self, controller, key, code, state):
        if key in (Gdk.KEY_Up, Gdk.KEY_Page_Up, Gdk.KEY_Home):
            self.hold()
        return False

    def scrolled(self, adjustment):
        if self.dragging and not self.anchoring and adjustment.get_value() < adjustment.get_upper() - adjustment.get_page_size() - 24:
            self.hold()

    def hold(self):
        self.state.paused = True
        self.update_heading()

    def resume(self):
        self.state.resume()
        buffer = self.text.get_buffer()
        buffer.place_cursor(buffer.get_end_iter())
        self.render()

    def update(self, value, identity, live):
        self.live = live
        self.state.update(value, identity, self.text.get_buffer().get_has_selection())
        self.render()

    def render(self):
        buffer = self.text.get_buffer()
        current = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)
        if current != self.state.displayed:
            buffer.set_text(self.state.displayed)
        self.update_heading()
        self.schedule_tail()

    def update_heading(self):
        update_label(self.heading, ('Paused · Updates waiting' if self.state.latest != self.state.displayed else 'Reading paused')
                     if self.state.paused else 'Live activity' if self.live else 'Recorded activity')
        self.pause.set_sensitive(not self.state.paused)
        self.latest.set_label('Resume' if self.state.paused else 'Latest')

    def schedule_tail(self):
        if self.alive and self.tail_source is None and not self.state.paused:
            self.tail_source = GLib.idle_add(self.anchor_tail)

    def anchor_tail(self):
        self.tail_source = None
        if self.alive and not self.state.paused and not self.text.get_buffer().get_has_selection():
            self.anchoring = True
            buffer = self.text.get_buffer()
            buffer.move_mark(self.tail_mark, buffer.get_end_iter())
            # TextView validates wrapped text before scrolling to a mark. This
            # also follows the tail when the first layout was not ready at idle.
            self.text.scroll_to_mark(self.tail_mark, 0, True, 0, 1)
            adjustment = self.pane.get_vadjustment()
            adjustment.set_value(max(0, adjustment.get_upper() - adjustment.get_page_size()))
            self.anchoring = False
        return False

    def dispose(self):
        self.alive = False
        if self.tail_source is not None:
            GLib.source_remove(self.tail_source)
            self.tail_source = None


class PodRow:
    def __init__(self, workspace):
        self.workspace = workspace
        self.compact = False
        self.view = Gtk.Frame()
        self.view.add_css_class('pod')
        self.view.set_size_request(344, -1)
        content = box(spacing=6, margin=12)
        self.view.set_child(content)
        top = box(False, spacing=8)
        self.name = line(Path(workspace.folder).name or workspace.folder, 'title-3')
        self.name.set_tooltip_text(workspace.folder)
        self.status = label('', 'heading')
        self.status.set_wrap(False)
        top.append(self.name)
        top.append(self.status)
        content.append(top)
        self.thread = line('', 'dim-label')
        self.instruction = line()
        self.timing = line('', 'dim-label')
        self.note = line('', 'dim-label')
        for control in (self.thread, self.instruction, self.timing, self.note):
            content.append(control)
        self.feed = PodFeed()
        self.approval = ApprovalView(workspace)
        self.review = self.approval.view
        self.stack = Gtk.Stack(vexpand=True, hhomogeneous=True, vhomogeneous=True)
        self.stack.add_titled(self.feed.view, 'activity', 'Activity')
        self.review_page = self.stack.add_titled(self.review, 'request', 'Review request')
        self.switcher = Gtk.StackSwitcher(stack=self.stack, halign=Gtk.Align.FILL)
        content.append(self.switcher)
        content.append(self.stack)
        self.review_key = None
        self.open = button('Conversation', self.open_workspace)
        self.open.set_tooltip_text('Open this project’s conversation and composer')
        self.stop = button('Stop Agent', workspace.commands.stop)
        self.stop.set_tooltip_text('Stop active and queued agent work in this project. Project files are kept.')
        more = Gtk.MenuButton(label='More')
        more.set_tooltip_text('Project checkpoints and connection recovery')
        menu = Gtk.Popover()
        menu_body = box(margin=8, spacing=6)
        menu.set_child(menu_body)
        more.set_popover(menu)
        def action(callback):
            menu.popdown()
            callback()
        self.checkpoints = button('Checkpoints…', lambda: action(workspace.commands.checkpoints))
        self.reconnect = button('Reconnect Agent', lambda: action(workspace.commands.reconnect))
        self.connection_details = button('Connection details…', lambda: action(workspace.show_connection_details))
        for control in (self.checkpoints, self.reconnect, self.connection_details):
            menu_body.append(control)
        actions = box(False, spacing=6)
        actions.append(self.open)
        actions.append(more)
        spacer = box()
        spacer.set_hexpand(True)
        actions.append(spacer)
        actions.append(self.stop)
        content.append(actions)

    def open_workspace(self):
        if not self.workspace.closed:
            self.workspace.show_conversation()
            self.workspace.present()
            self.workspace.composer.grab_focus()

    def update(self, value):
        workspace = self.workspace
        for control, text in ((self.status, value['status']), (self.thread, value['thread']),
                              (self.instruction, value['instruction'] or 'Open Conversation to start a task.'),
                              (self.timing, value['timing'] + (f" · {value['queued']} queued" if value['queued'] else '')),
                              (self.note, value['note'])):
            update_label(control, text)
        self.note.set_visible(bool(value['note']) and (not self.compact or bool(workspace.commands.stop_error)))
        self.name.set_tooltip_text('\n'.join(part for part in
                                  (workspace.folder, value['thread'], value['timing'], value['note']) if part))
        self.approval.update()
        self.review_page.set_visible(value['review'])
        self.switcher.set_visible(value['review'])
        # Never put a replacement request under an existing Allow button.
        if value['review'] and self.review_key is None:
            self.stack.set_visible_child_name('request')
        elif not value['review']:
            self.stack.set_visible_child_name('activity')
        self.review_key = workspace.commands.approval_key
        self.feed.update(stream_text(value['run']) or 'Activity will appear here when this project starts working.',
                         value['identity'], value['running'])
        self.stop.set_sensitive(workspace.commands.can_stop())
        self.stop.set_label('Stopping…' if workspace.commands.stop_pending else 'Stop Agent')
        self.reconnect.set_sensitive(workspace.commands.can_reconnect())
        self.checkpoints.set_sensitive(workspace.commands.can_checkpoints())
        self.connection_details.set_sensitive(bool(workspace.client and workspace.client.closed))

    def focus_request(self):
        self.stack.set_visible_child_name('request')
        (self.approval.next if self.approval.next.get_visible() else self.approval.details).grab_focus()

    def adapt(self, compact):
        self.compact = compact
        self.thread.set_visible(not compact)
        self.timing.set_visible(not compact)
        self.note.set_visible(bool(self.note.get_text()) and (not compact or bool(self.workspace.commands.stop_error)))
        self.feed.pane.set_min_content_height(80 if compact else 140)
        self.approval.pane.set_min_content_height(0)
        self.approval.pane.set_max_content_height(56 if compact else 88)
        self.approval.pane.set_min_content_height(56 if compact else 88)
        self.approval.message.set_lines(1 if compact else 2)

    def dispose(self):
        self.feed.dispose()


class Pods(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title='Pods — LUMI', default_width=1180, default_height=780)
        self.app, self.rows, self.mode = app, {}, 'all'
        self.alive, self.last_reviewed = True, None
        self.compact = False
        self.reveal_target, self.reveal_frame = None, None
        self.reveal_tick = None
        self.last_refresh = GLib.get_monotonic_time()
        self.chooser = None
        header = Gtk.HeaderBar()
        header.set_title_widget(label('Pods', 'title-3'))
        header.pack_start(button('Project Library…', app.show_library))
        header.pack_end(button('Load Projects…', self.load_projects, 'suggested-action'))
        self.set_titlebar(header)
        body = box(margin=16, spacing=8)
        self.load_error = label('', 'error')
        self.load_error.set_visible(False)
        self.load_error.set_lines(3)
        self.load_error.set_ellipsize(Pango.EllipsizeMode.END)
        body.append(self.load_error)
        controls = box(False, spacing=12)
        filters = box(False, spacing=0)
        filters.add_css_class('linked')
        self.filters = {}
        for mode, title in (('all', 'All'), ('working', 'Working'), ('attention', 'Attention')):
            toggle = Gtk.ToggleButton(label=title)
            if self.filters:
                toggle.set_group(self.filters['all'])
            toggle.connect('toggled', lambda control, choice=mode: self.select_filter(choice) if control.get_active() else None)
            self.filters[mode] = toggle
            filters.append(toggle)
        controls.append(filters)
        self.query = Gtk.SearchEntry(placeholder_text='Find project or task')
        self.query.set_hexpand(True)
        self.query.update_property([Gtk.AccessibleProperty.LABEL], ['Find a project or task'])
        # Four local projects need no debounce; a delayed reset would undo
        # Next Request's focus/scroll after it clears the search.
        self.query.connect('changed', lambda *_: self.filter_changed())
        controls.append(self.query)
        body.append(controls)
        status = box(False, spacing=8)
        self.summary = line('', 'dim-label')
        status.append(self.summary)
        self.attention = button('Next Request', self.focus_next_request)
        self.attention.set_tooltip_text('Find the next approval across all projects, including filtered projects (Ctrl+J)')
        status.append(self.attention)
        body.append(status)
        self.list = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True,
                                min_children_per_line=1, max_children_per_line=3,
                                column_spacing=12, row_spacing=12, valign=Gtk.Align.START)
        self.board = scroll(self.list)
        self.board.get_child().set_scroll_to_focus(True)
        self.list.set_vadjustment(self.board.get_vadjustment())
        body.append(self.board)
        self.empty = box(margin=24, spacing=12)
        self.empty_title = label('', 'title-2')
        self.empty_body = label('', 'dim-label')
        self.empty.append(self.empty_title)
        self.empty.append(self.empty_body)
        self.empty_load = button('Load Projects…', self.load_projects, 'suggested-action')
        self.empty_reset = button('Show All Projects', self.show_all)
        for control in (self.empty_load, self.empty_reset):
            control.set_halign(Gtk.Align.START)
            self.empty.append(control)
        body.append(self.empty)
        self.set_child(body)
        self.filters['all'].set_active(True)
        keys = Gtk.EventControllerKey()
        keys.connect('key-pressed', self.key_pressed)
        self.add_controller(keys)
        self.timer = GLib.timeout_add(100, self.tick)
        self.connect('close-request', self.closed)
        self.update()
        self.present()
        self.query.grab_focus()

    def load_projects(self):
        if self.chooser is None:
            self.chooser = self.app.choose_folder(self, multiple=True, selected=self.projects_chosen,
                                                   finished=lambda: setattr(self, 'chooser', None))

    def projects_chosen(self, paths):
        if not self.alive:
            return
        errors = []
        for path in paths:
            self.app.open_workspace(path, on_error=errors.append)
        message = '\n'.join(errors[:3])
        if len(errors) > 3:
            message += f'\n{len(errors) - 3} more projects could not be loaded.'
        self.load_error.set_text(message)
        self.load_error.set_tooltip_text(message)
        self.load_error.set_visible(bool(errors))
        self.show_all()
        self.present()

    def key_pressed(self, controller, key, code, state):
        if state & Gdk.ModifierType.CONTROL_MASK and not state & Gdk.ModifierType.ALT_MASK:
            action = {Gdk.KEY_f: self.query.grab_focus, Gdk.KEY_o: self.load_projects,
                      Gdk.KEY_j: self.focus_next_request, Gdk.KEY_w: self.close}.get(key)
            if action:
                action()
                return True
        if key == Gdk.KEY_Escape and self.query.get_text():
            self.query.set_text('')
            self.filter_changed()
            return True
        return False

    def select_filter(self, mode):
        self.mode = mode
        if self.filters[mode].get_active():
            self.filter_changed()
        else:
            self.filters[mode].set_active(True)

    def filter_changed(self):
        self.cancel_reveal()
        self.update()
        self.board.get_vadjustment().set_value(0)

    def show_all(self):
        self.query.set_text('')
        self.select_filter('all')

    def focus_next_request(self):
        self.show_all()
        paths = [path for path, row in self.rows.items() if row.workspace.commands.approval_key]
        if paths:
            index = (paths.index(self.last_reviewed) + 1) % len(paths) if self.last_reviewed in paths else 0
            self.last_reviewed = paths[index]
            self.rows[self.last_reviewed].stack.set_visible_child_name('request')
            self.reveal_target, self.reveal_frame = self.last_reviewed, None
            self.reveal_tick = self.add_tick_callback(self.reveal_request)

    def adapt_layout(self):
        compact = 0 < self.board.get_height() < 400
        if compact != self.compact:
            self.compact = compact
            for row in self.rows.values():
                row.adapt(compact)

    def reveal_request(self, widget, clock):
        # Filtering can unhide a card before GTK has allocated its new row.
        # Reveal its complete review on the next frame, after that allocation.
        if self.reveal_frame is None:
            self.reveal_frame = clock.get_frame_counter()
            return True
        row = self.rows.get(self.reveal_target)
        if row and row.review.get_mapped():
            found, bounds = row.review.compute_bounds(self.list)
            if found:
                # Focusing earlier schedules a scroll to the child's old row.
                row.focus_request()
                self.board.get_vadjustment().clamp_page(bounds.get_y(), bounds.get_y() + bounds.get_height())
        self.reveal_target = self.reveal_tick = None
        return False

    def cancel_reveal(self):
        if self.reveal_tick is not None:
            self.remove_tick_callback(self.reveal_tick)
        self.reveal_target = self.reveal_tick = None

    def tick(self):
        if self.alive and self.get_mapped():
            self.adapt_layout()
            now = GLib.get_monotonic_time()
            if now - self.last_refresh >= 500_000:
                self.last_refresh = now
                self.update()
        return self.alive

    def update(self):
        if not self.alive:
            return False
        for path in list(self.rows):
            workspace = self.app.workspaces.get(path)
            if workspace is not self.rows[path].workspace:
                row = self.rows.pop(path)
                row.dispose()
                self.list.remove(row.view.get_parent())
        values = []
        for path, workspace in self.app.workspaces.items():
            if workspace.closed:
                continue
            if path not in self.rows:
                self.rows[path] = PodRow(workspace)
                self.rows[path].adapt(self.compact)
                self.list.append(self.rows[path].view)
            row = self.rows[path]
            value = snapshot(workspace, time.time() * 1000)
            values.append(value)
            row.update(value)
            show = includes(value, self.mode, self.query.get_text())
            row.view.set_visible(show)
            row.view.get_parent().set_visible(show)
        visible = sum(row.view.get_visible() for row in self.rows.values())
        total, requests = len(values), sum(value['review'] for value in values)
        working = sum(value['running'] for value in values)
        summary = ('No projects loaded yet.' if not total else
                   f'Showing {visible} of {total} projects · {requests} requests total' if visible != total else
                   f'{total} project' + ('' if total == 1 else 's') + f' loaded · {working} working · {requests} need review')
        update_label(self.summary, summary)
        self.attention.set_sensitive(bool(requests))
        self.empty.set_visible(not visible)
        self.board.set_visible(bool(visible))
        self.empty_title.set_text('No matching projects' if total else 'Load a project pod')
        self.empty_body.set_text('Other agents keep working while this view is filtered.' if total else
                                'Choose one or more project folders. Each pod keeps its agent, conversation, queue and checkpoints separate. Up to four projects can be open at once.')
        self.empty_load.set_visible(not total)
        self.empty_reset.set_visible(bool(total))
        return True

    def closed(self, *_):
        self.dispose()
        return False

    def dispose(self):
        if not self.alive:
            return
        self.alive = False
        GLib.source_remove(self.timer)
        self.cancel_reveal()
        for row in self.rows.values():
            row.dispose()
        if self.chooser:
            self.chooser.destroy()
            self.chooser = None
        if self.app.pods_window is self:
            self.app.pods_window = None

    def destroy(self):
        self.dispose()
        Gtk.Window.destroy(self)
