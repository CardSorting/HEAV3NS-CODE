"""Keyboard-first commands and filename search, with current-result activation."""
from gi.repository import Gdk, GLib, Gtk, Pango
from .navigation import matches
from .widgets import Panel, box, button, clear, label, scroll


class Picker(Panel):
    def __init__(self, owner, title, placeholder):
        super().__init__(owner, title, 660, 520)
        self.query = Gtk.SearchEntry(placeholder_text=placeholder)
        self.body.append(self.query)
        self.items = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.items.set_activate_on_single_click(False)
        self.items.connect('row-activated', lambda _, row: self.activate(row))
        self.body.append(scroll(self.items))
        self.status = label('Type to filter · ↑↓ to choose · Enter to open · Esc to close', 'dim-label')
        self.body.append(self.status)
        self.query.connect('activate', lambda *_: self.activate(self.items.get_selected_row()))
        keys = Gtk.EventControllerKey()
        keys.connect('key-pressed', self.keys)
        self.query.add_controller(keys)

    def keys(self, controller, key, code, state):
        if key not in (Gdk.KEY_Down, Gdk.KEY_Up):
            return False
        current = self.items.get_selected_row()
        index = current.get_index() if current else -1
        row = self.items.get_row_at_index(max(0, index + (1 if key == Gdk.KEY_Down else -1)))
        if row:
            self.items.select_row(row)
            row.grab_focus()
        return True

    def add_row(self, identity, title, detail='', shortcut='', enabled=True):
        row = Gtk.ListBoxRow()
        row.identity = identity
        content = box(False, margin=10)
        text = box(spacing=4)
        text.set_hexpand(True)
        title_label = label(title, 'heading')
        title_label.set_wrap(False)
        title_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        text.append(title_label)
        if detail:
            secondary = label(detail, 'dim-label')
            secondary.set_wrap(False)
            secondary.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
            text.append(secondary)
        content.append(text)
        if shortcut:
            content.append(label(shortcut, 'dim-label'))
        row.set_child(content)
        row.set_tooltip_text(title + '\n' + detail)
        row.set_sensitive(enabled)
        self.items.append(row)
        if not self.items.get_selected_row() and enabled:
            self.items.select_row(row)
        return row

    def activate(self, row):
        raise NotImplementedError


class CommandPalette(Picker):
    def __init__(self, owner):
        super().__init__(owner, 'Workspace actions', 'Search actions…')
        self.query.connect('changed', lambda *_: self.populate())
        self.populate()
        self.present()
        self.query.grab_focus()

    def populate(self):
        previous = self.items.get_selected_row()
        identity = previous.identity if previous else None
        clear(self.items)
        count = 0
        for action in self.owner.actions():
            if matches(self.query.get_text(), action['title'], action.get('keywords', '')):
                row = self.add_row(action['id'], action['title'], action.get('reason', ''), action.get('shortcut', ''), action['enabled'])
                if row.identity == identity and action['enabled']:
                    self.items.select_row(row)
                count += 1
        self.status.set_text(f'{count} actions · Enter runs the selected action' if count else 'No matching actions. Try “file”, “run”, “memory” or “pods”.')

    def activate(self, row):
        if not row or not self.valid_scope():
            return
        action = next((item for item in self.owner.actions() if item['id'] == row.identity), None)
        if action and action['enabled'] and matches(self.query.get_text(), action['title'], action.get('keywords', '')):
            self.destroy()
            action['callback']()
        else:
            self.populate()
            self.show_error('This action is unavailable in the current workspace state.')


class QuickOpen(Picker):
    def __init__(self, owner):
        super().__init__(owner, 'Open file', 'Search filenames and paths…')
        self.timer = None
        self.searching = False
        # GtkSearchEntry's search-changed is delayed. Invalidate immediately so
        # Enter after typing cannot activate the previous query's selected file.
        self.query.connect('changed', lambda *_: self.schedule())
        self.body.append(button('Refresh file index', lambda: self.search(True)))
        self.search()
        self.present()
        self.query.grab_focus()

    def schedule(self):
        self.gate.issue('files')
        clear(self.items)
        self.status.set_text('Searching…')
        if self.timer:
            GLib.source_remove(self.timer)
            self.timers.discard(self.timer)
        def run():
            self.timers.discard(self.timer)
            self.timer = None
            self.search()
            return False
        self.timer = GLib.timeout_add(180, run)
        self.timers.add(self.timer)

    def search(self, refresh=False):
        query = self.query.get_text()
        self.searching = True
        def loaded(result):
            self.searching = False
            clear(self.items)
            for item in result.get('entries', []):
                if not item.get('directory'):
                    path = item['path']
                    self.add_row(path, path.rsplit('/', 1)[-1], path)
            count = result.get('matched', 0)
            limited = result.get('more') or result.get('scanLimited')
            self.status.set_text(f"{count} matches · {result.get('scope', 'workspace')} filenames" + (' · Refine your search for more results' if limited else '') if count else 'No files match. Try a shorter filename or refresh the index.')
        self.request('files.search', {'query': query, 'refresh': refresh}, loaded, lane='files')

    def activate(self, row):
        if row and not self.searching and not self.timer and self.valid_scope():
            path = row.identity
            self.destroy()
            self.owner.evidence(path, 'files.read', {'path': path}, True)
