"""Persistent native task-context sidebar: Walkthrough, Changes, Inspect, Run."""
import time
from gi.repository import Gtk, Pango
from .context_browser import ContextBrowser
from .inspector import Inspector
from .project_run import ProjectRun
from .walkthrough import Walkthrough
from .widgets import box, button, icon_button, label

TABS = ('walkthrough', 'changes', 'inspect', 'run')


class TaskContext(Gtk.Box):
    def __init__(self, owner):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=10, hexpand=True, vexpand=True)
        self.owner, self.scope = owner, None
        self.views = []
        self.selected = owner.layout_preferences.get('tab', 'walkthrough')
        self.changing = False
        self.last_tick = 0
        self.set_size_request(370, -1)
        for side in ('top', 'bottom', 'start', 'end'):
            getattr(self, 'set_margin_' + side)(14)
        heading = box(False, spacing=6)
        title = label('Task context', 'title-3')
        title.set_hexpand(True)
        title.set_selectable(False)
        heading.append(title)
        heading.append(button('Open file…', owner.files))
        heading.append(icon_button('window-close-symbolic', 'Hide task context (Ctrl+Alt+B)', owner.hide_context))
        self.append(heading)
        tab_bar = box(False, spacing=0)
        tab_bar.add_css_class('linked')
        self.tabs = {}
        for key in TABS:
            control = Gtk.ToggleButton(label=key.capitalize(), hexpand=True)
            if self.tabs:
                control.set_group(next(iter(self.tabs.values())))
            control.connect('toggled', lambda widget, name=key: self.select(name) if widget.get_active() and not self.changing else None)
            self.tabs[key] = control
            tab_bar.append(control)
        self.append(tab_bar)
        self.notice = label('Connect to LUMI to load task context.', 'dim-label')
        self.append(self.notice)
        self.stack = Gtk.Stack(vexpand=True, hexpand=True, hhomogeneous=False, vhomogeneous=False)
        self.append(self.stack)
        self.reset()

    def reset(self):
        for view in self.views:
            view.invalidate('The workspace scope changed.')
            view.destroy()
        child = self.stack.get_first_child()
        while child:
            self.stack.remove(child)
            child = self.stack.get_first_child()
        self.scope = (self.owner.client, self.owner.conversation)
        self.browser = ContextBrowser(self.owner)
        self.inspector = Inspector(self.owner)
        self.inspector.on_open = self.inspection_opened
        self.inspector.view.get_buffer().set_text('Select a file or recorded instruction above. Opening evidence does not execute work.')
        self.walkthrough = Walkthrough(self.owner)
        self.project = ProjectRun(self.owner)
        self.views = [self.browser, self.inspector, self.walkthrough, self.project]
        self.inspection_surface = box(spacing=8)
        controls = box(False, spacing=6)
        self.destination = Gtk.ComboBoxText(hexpand=True)
        for key, name in [('files', 'Project files'), ('runs', 'Recorded instructions'), ('context', 'Conversation context')]:
            self.destination.append(key, name)
        self.destination.set_active_id('files')
        self.destination.connect('changed', self.destination_changed)
        controls.append(self.destination)
        self.browse = Gtk.ToggleButton(label='Browse', active=True)
        self.browse.connect('toggled', lambda widget: self.browser.set_visible(widget.get_active()))
        controls.append(self.browse)
        self.inspection_surface.append(controls)
        self.split = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL, vexpand=True, wide_handle=True)
        self.split.set_start_child(self.browser)
        self.split.set_end_child(self.inspector)
        self.split.set_position(260)
        self.split.set_resize_start_child(False)
        self.split.set_shrink_start_child(True)
        self.split.set_shrink_end_child(True)
        self.inspection_surface.append(self.split)
        links = box(spacing=6, margin=8)
        for title, capability, action in [('Context', 'conversation-context-v1', self.open_context), ('Memory', 'conversation-memory-v1', self.owner.memory), ('Saved state', 'runtime-state-v1', lambda: self.owner.evidence('Saved state', 'state.inspect', {'conversation': self.owner.conversation})), ('Checkpoints', 'checkpoints-v1', self.owner.checkpoints)]:
            control = button(title, lambda selected=action: (popover.popdown(), selected()))
            control.capability = capability
            links.append(control)
        self.links = links
        more = Gtk.MenuButton(label='Context & recovery')
        popover = Gtk.Popover()
        popover.set_child(links)
        more.set_popover(popover)
        self.inspection_surface.append(more)
        self.stack.add_named(self.walkthrough, 'walkthrough')
        self.stack.add_named(self.inspection_surface, 'inspect')
        self.stack.add_named(self.project, 'run')
        self.owner.inspector = self.inspector
        self.select(self.selected, load=False)

    def ready(self):
        ws = self.owner
        return bool(ws.client and ws.client.ready and not ws.client.closed and ws.connected_once and not ws.switching)

    def select(self, name, load=True):
        if name not in TABS:
            return
        self.selected, self.changing = name, True
        self.tabs[name].set_active(True)
        self.changing = False
        self.stack.set_visible_child_name('inspect' if name in ('inspect', 'changes') else name)
        self.destination.set_visible(name == 'inspect')
        self.browse.set_visible(name in ('inspect', 'changes'))
        if name == 'changes':
            self.browser.configure('changes', load=load and self.ready())
        elif name == 'inspect' and self.destination.get_active_id() != 'context':
            self.browser.configure(self.destination.get_active_id(), load=load and self.ready())
        elif name == 'run' and load and self.ready() and 'project-run-v1' in self.owner.client.capabilities:
            self.project.refresh()
        self.owner.layout_preferences['tab'] = name
        if hasattr(self.owner, 'composer'):
            self.owner.draft_changed()
        self.update()

    def destination_changed(self, *_):
        if self.destination.get_active_id() == 'context':
            self.open_context()
        else:
            self.browse.set_active(True)
            self.browser.configure(self.destination.get_active_id(), load=self.ready())

    def open_context(self):
        self.owner.evidence('Conversation context', 'context.inspect', {'conversation': self.owner.conversation})
        self.browse.set_active(False)

    def inspection_opened(self):
        target = self.inspector.history.current
        name = 'changes' if target and target.method == 'changes.read' else 'inspect'
        self.owner.show_context(name)
        if self.owner.get_width() < 1140 or self.owner.get_height() < 760:
            self.browse.set_active(False)

    def update(self):
        if self.scope != (self.owner.client, self.owner.conversation):
            self.reset()
            return
        ready = self.ready()
        caps = self.owner.client.capabilities if self.owner.client else set()
        supported = self.selected != 'run' or 'project-run-v1' in caps
        if self.selected == 'changes':
            supported = 'changes' in caps
        self.notice.set_visible(not ready or not supported)
        self.notice.set_text('Changing conversation…' if self.owner.switching else 'Disconnected · showing last confirmed evidence. Reconnect to refresh.' if not ready else 'This runtime does not support this tool.')
        # Keep recorded text selectable while disconnected; mutations still go
        # through scoped requests and the closed worker rejects them.
        self.project.body.set_sensitive(ready and 'project-run-v1' in caps)
        self.browser.body.set_sensitive(ready)
        # Recovery is the current Changes content. Give it the full pane and
        # avoid presenting an unrelated or stale diff beneath the diagnosis.
        self.inspector.set_visible(not (self.selected == 'changes' and self.browser.git_problem and self.browse.get_active()))
        control = self.links.get_first_child()
        while control:
            control.set_sensitive(ready and control.capability in caps)
            control = control.get_next_sibling()
        self.walkthrough.update()
        if ready and self.get_mapped() and time.monotonic() - self.last_tick > 2:
            self.last_tick = time.monotonic()
            if self.selected == 'run' and supported:
                self.project.refresh()
            elif self.selected in ('inspect', 'changes') and not self.browser.loaded and not self.browser.loading:
                self.browser.reload()

    def dispose(self):
        for view in self.views:
            view.destroy()
