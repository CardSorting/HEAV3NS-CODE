"""Docked app controls sharing the workspace worker and authoritative status."""
import time
from gi.repository import Gio, Gtk
from .state import preview_url
from .widgets import EmbeddedPanel, box, button, label, scroll, text_view, text_value


class ProjectRun(EmbeddedPanel):
    def __init__(self, owner):
        super().__init__(owner, 'Run app')
        self.choices, self.status = {}, {}
        self.loaded, self.loading, self.last_read = False, False, 0
        self.body.append(label('Run your app', 'title-3'))
        self.summary = label('Discover a launch target or save a command.', 'dim-label')
        self.body.append(self.summary)
        self.targets = Gtk.ComboBoxText()
        self.targets.connect('changed', self.selected)
        self.body.append(self.targets)
        self.command_info = label('')
        self.body.append(self.command_info)
        actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=3)
        self.start = button('Start app', self.start_app, 'suggested-action')
        self.stop = button('Stop app', lambda: self.request('project.stop', {}, self.refreshed))
        self.preview = button('Open preview', self.open_preview)
        self.refresh_button = button('Refresh', self.refresh)
        for widget in (self.start, self.stop, self.preview, self.refresh_button):
            actions.append(widget)
        self.body.append(actions)
        self.console = text_view(monospace=True)
        self.console.update_property([Gtk.AccessibleProperty.LABEL], ['App output'])
        self.console_scroll = scroll(self.console)
        self.body.append(self.console_scroll)
        self.latest = button('Show latest output', self.latest_output)
        self.latest.set_visible(False)
        self.body.append(self.latest)
        self.diagnostic = label('', 'dim-label')
        self.body.append(self.diagnostic)
        self.repair = button('Inspect repair', self.inspect_repair)
        self.repair.set_visible(False)
        self.body.append(self.repair)
        self.healing = Gtk.CheckButton(label='Allow automatic app repair')
        self.healing.set_tooltip_text('Allow the shared runtime to repair app failures automatically.')
        self.healing_handler = self.healing.connect('toggled', self.toggle_healing)
        self.body.append(self.healing)
        configure = Gtk.Expander(label='Configure a launch command')
        fields = box(spacing=6, margin=8)
        self.command = Gtk.Entry(placeholder_text='For example: npm run dev')
        fields.append(self.command)
        fields.append(label('Commands run in this project when you choose Start app.', 'dim-label'))
        fields.append(button('Save command', self.save_command))
        configure.set_child(fields)
        self.body.append(configure)
        self.start.set_sensitive(False)
        self.stop.set_sensitive(False)
        self.preview.set_sensitive(False)
        self.healing.set_sensitive(False)

    def selected(self, *_):
        target = self.choices.get(self.targets.get_active_id(), {})
        self.command_info.set_text(target.get('command', 'No runnable app found. Configure a command below.'))
        self.start.set_sensitive(bool(target) and self.status.get('state') not in ('running', 'starting', 'stopping'))

    def discover(self):
        def loaded(result):
            selected = self.targets.get_active_id()
            self.choices = {item['id']: item for item in result.get('targets', [])}
            self.targets.remove_all()
            for identity, item in self.choices.items():
                self.targets.append(identity, item['title'])
            if selected in self.choices:
                self.targets.set_active_id(selected)
            else:
                self.targets.set_active(0)
            self.selected()
        self.request('project.discover', {}, loaded, lane='targets')

    def refresh(self):
        if self.loading:
            return
        self.loading, self.last_read = True, time.monotonic()
        if not self.loaded:
            self.discover()
        def loaded(result):
            self.loading, self.loaded = False, True
            self.refreshed(result)
        def failed(error):
            self.loading = False
            self.show_error(error)
        self.request('project.status', {}, loaded, failed)

    def refreshed(self, result):
        if result.get('revision', 0) < self.status.get('revision', 0):
            return
        self.status = result
        self.summary.set_text(result.get('state', 'Unknown').replace('_', ' ').capitalize())
        output = result.get('output', '')
        if text_value(self.console) != output:
            adjustment = self.console_scroll.get_vadjustment()
            if self.console.get_buffer().get_selection_bounds() or adjustment.get_value() < adjustment.get_upper() - adjustment.get_page_size() - 12:
                self.latest.set_visible(True)
            else:
                self.console.get_buffer().set_text(output)
                self.latest.set_visible(False)
        self.diagnostic.set_text((result.get('diagnostic') or '') + ('\nOutput is limited to the retained window.' if result.get('outputLimited') else ''))
        self.diagnostic.set_visible(bool(self.diagnostic.get_text()))
        self.repair.set_visible(bool(result.get('repair', {}).get('run')))
        self.preview.set_sensitive(preview_url(result.get('preview', '')))
        self.stop.set_sensitive(result.get('state') in ('running', 'starting', 'stopping', 'repairing'))
        self.healing.handler_block(self.healing_handler)
        self.healing.set_active(result.get('healing', {}).get('enabled', True))
        self.healing.handler_unblock(self.healing_handler)
        self.healing.set_sensitive(True)
        self.selected()

    def latest_output(self):
        self.console.get_buffer().set_text(self.status.get('output', ''))
        self.console.scroll_to_iter(self.console.get_buffer().get_end_iter(), 0, False, 0, 0)
        self.latest.set_visible(False)

    def inspect_repair(self):
        identity = self.status.get('repair', {}).get('run')
        if identity and self.valid_scope():
            self.owner.evidence('App repair', 'history.read', {'run': identity})

    def start_app(self):
        target = self.choices.get(self.targets.get_active_id())
        if target and self.start.get_sensitive():
            self.request('project.start', {'id': target['id'], 'revision': target['revision']}, self.refreshed)

    def save_command(self):
        self.request('project.configure', {'command': self.command.get_text()}, lambda _: self.discover())

    def toggle_healing(self, *_):
        def failed(error):
            self.show_error(error)
            self.healing.handler_block(self.healing_handler)
            self.healing.set_active(self.status.get('healing', {}).get('enabled', True))
            self.healing.handler_unblock(self.healing_handler)
        self.request('project.healing', {'enabled': self.healing.get_active()}, self.refreshed, failed)

    def open_preview(self):
        url = self.status.get('preview', '')
        if self.valid_scope() and preview_url(url):
            try:
                Gio.AppInfo.launch_default_for_uri(url, None)
            except Exception as error:
                self.show_error('Could not open the preview: ' + str(error))
