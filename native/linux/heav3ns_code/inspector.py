"""One navigable, paged inspector per workspace; stale reads cannot replace it."""
import json
from gi.repository import Gdk, GLib, Gtk, Pango
from .navigation import Destination, History, outline, safe_file
from .presentation import render_evidence, humanize, observed
from .widgets import EmbeddedPanel, box, button, clear, icon_button, label, scroll, text_view


class Inspector(EmbeddedPanel):
    def __init__(self, owner):
        super().__init__(owner, "Inspect")
        self.history = History()
        self.offsets = [0]
        self.page = 0
        self.revision = None
        self.result = {}
        self.loading = False
        self.read_serial = 0
        self.on_open = None
        navigation = box(False)
        self.back = icon_button('go-previous-symbolic', 'Back (Alt+Left)', lambda: self.travel(-1))
        self.forward = icon_button('go-next-symbolic', 'Forward (Alt+Right)', lambda: self.travel(1))
        navigation.append(self.back)
        navigation.append(self.forward)
        self.heading = label('Inspect', 'heading')
        self.heading.set_hexpand(True)
        self.heading.set_wrap(False)
        self.heading.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        navigation.append(self.heading)
        navigation.append(icon_button('view-refresh-symbolic', 'Reload (Ctrl+R)', self.reload))
        navigation.append(icon_button('edit-find-symbolic', 'Find in this page (Ctrl+F)', self.focus_find))
        self.body.append(navigation)
        self.file_actions = box(False, spacing=6)
        self.copy_path = button('Copy path', self.copy_current_path)
        self.check_file = button('Check code', self.check_current_file)
        self.staged = Gtk.CheckButton(label='Staged diff')
        self.staged_handler = self.staged.connect('toggled', self.change_diff_scope)
        for control in (self.copy_path, self.check_file, self.staged):
            self.file_actions.append(control)
        self.file_actions.set_visible(False)
        self.body.append(self.file_actions)
        self.search = Gtk.SearchEntry(placeholder_text='Find in this page')
        self.search.set_visible(False)
        self.search.connect('search-changed', lambda *_: self.find(False, reset=True))
        self.search.connect('activate', lambda *_: self.find(False))
        self.search.connect('next-match', lambda *_: self.find(False))
        self.search.connect('previous-match', lambda *_: self.find(True))
        self.search.connect('stop-search', lambda *_: self.hide_find())
        self.body.append(self.search)
        self.find_status = label('', 'dim-label')
        self.find_status.set_visible(False)
        self.body.append(self.find_status)
        self.outline = Gtk.ComboBoxText()
        self.outline.set_tooltip_text('Declarations on the displayed page · lexical outline, not a language-server index')
        self.outline.connect('changed', self.jump_declaration)
        self.body.append(self.outline)
        self.view = text_view()
        self.view.set_cursor_visible(True)
        self.view.update_property([Gtk.AccessibleProperty.LABEL], ['Read-only inspection'])
        self.reader = scroll(self.view)
        self.body.append(self.reader)
        self.related = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=4)
        self.related.set_visible(False)
        self.body.append(self.related)
        self.footer = label('', 'dim-label')
        self.body.append(self.footer)
        pagination = box(False)
        self.previous = button('Previous page', lambda: self.turn_page(-1))
        self.next = button('Next page', lambda: self.turn_page(1))
        pagination.append(self.previous)
        pagination.append(self.next)
        self.raw = Gtk.CheckButton(label='Show structured data')
        self.raw.connect('toggled', lambda *_: self.display())
        self.body.append(self.raw)
        self.body.append(pagination)
        keys = Gtk.EventControllerKey()
        keys.connect('key-pressed', self.keys)
        self.add_controller(keys)

    def _keys(self, controller, key, code, state):
        if key == Gdk.KEY_Escape and self.search.get_visible():
            self.hide_find()
            return True
        return False

    def keys(self, controller, key, code, state):
        if self._keys(controller, key, code, state):
            return True
        if state & Gdk.ModifierType.ALT_MASK and key in (Gdk.KEY_Left, Gdk.KEY_Right):
            self.travel(-1 if key == Gdk.KEY_Left else 1)
            return True
        if state & Gdk.ModifierType.CONTROL_MASK:
            if key in (Gdk.KEY_f, Gdk.KEY_F):
                self.focus_find()
                return True
            if key in (Gdk.KEY_r, Gdk.KEY_R):
                self.reload()
                return True
        return False

    def open(self, title, method, params=None, paged=False):
        self.history.visit(Destination.create(title, method, params, paged))
        self.reload()
        self.present()
        return self

    def travel(self, direction):
        if (direction < 0 and self.history.can_back) or (direction > 0 and self.history.can_forward):
            self.history.move(direction)
            self.reload()

    def reload(self):
        self.offsets, self.page, self.revision = [0], 0, None
        self.read()

    def copy_current_path(self):
        target = self.history.current
        if target and safe_file(target.arguments().get('path')):
            self.get_clipboard().set(target.arguments()['path'])

    def check_current_file(self):
        target = self.history.current
        if target and target.method == 'files.read':
            self.open('Code check', 'spider.check', {'paths': [target.arguments()['path']]})

    def change_diff_scope(self, *_):
        target = self.history.current
        if target and target.method == 'changes.read':
            self.open(target.title, target.method, {**target.arguments(), 'staged': self.staged.get_active()}, True)

    def turn_page(self, direction):
        if self.loading:
            return
        if direction > 0 and self.next.get_sensitive():
            next_offset = self.result['nextOffset']
            self.offsets = self.offsets[:self.page + 1] + [next_offset]
            self.page += 1
        elif direction < 0 and self.page > 0:
            self.page -= 1
        else:
            return
        self.read()

    def read(self):
        target = self.history.current
        if not target or not self.valid_scope():
            return
        if self.on_open:
            self.on_open()
        self.read_serial += 1
        serial = self.read_serial
        self.loading = True
        self.result = {}
        self.view.get_buffer().set_text('Loading…')
        self.heading.set_text(target.title)
        self.heading.set_tooltip_text(target.title)
        self.set_title(target.title + ' — Inspect')
        path = target.arguments().get('path', '')
        self.file_actions.set_visible(target.method in ('files.read', 'changes.read'))
        self.copy_path.set_visible(bool(path))
        self.check_file.set_visible(target.method == 'files.read' and path.rsplit('.', 1)[-1].lower() in ('js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs') and 'spider-check-v1' in getattr(self.client, 'capabilities', set()))
        self.staged.set_visible(target.method == 'changes.read')
        self.staged.handler_block(self.staged_handler)
        self.staged.set_active(bool(target.arguments().get('staged')))
        self.staged.handler_unblock(self.staged_handler)
        clear(self.related)
        self.outline.set_visible(False)
        self.raw.set_visible(not target.paged)
        self.back.set_sensitive(self.history.can_back)
        self.forward.set_sensitive(self.history.can_forward)
        self.previous.set_sensitive(False)
        self.next.set_sensitive(False)
        params = target.arguments()
        if target.paged:
            params['offset'] = self.offsets[self.page]
            if self.revision:
                params['revision'] = self.revision
        def loaded(result):
            if serial != self.read_serial:
                return
            self.loading = False
            self.result = result
            self.revision = result.get('revision')
            self.display()
        def failed(error):
            self.loading = False
            self.view.get_buffer().set_text('This view could not be loaded. Reload to try again. Your conversation remains available.')
            self.show_error(error)
        self.request(target.method, params, loaded, failed, lane='navigation')

    def display(self):
        target = self.history.current
        if not self.result or not target:
            return
        text = json.dumps(self.result, indent=2, ensure_ascii=False) if self.raw.get_active() and not target.paged else render_evidence(target.method, self.result)
        self.view.set_monospace(target.method in ('files.read', 'changes.read') or (self.raw.get_active() and not target.paged))
        self.view.get_buffer().set_text(text)
        self.find_status.set_text('')
        self.find_status.set_visible(False)
        self.outline.remove_all()
        entries = outline(text, target.arguments().get('path', '')) if target.method == 'files.read' else []
        self.outline.set_visible(bool(entries))
        if entries:
            self.outline.append('none', 'Go to declaration on this page…')
            for line, name, declaration in entries:
                self.outline.append(str(line), f'{line + 1} · {declaration}')
            self.outline.set_active_id('none')
        self.previous.set_sensitive(self.page > 0)
        self.next.set_sensitive(bool(target.paged and not self.result.get('binary') and self.result.get('nextOffset', 0) < self.result.get('size', 0)))
        self.previous.set_visible(self.page > 0 or self.next.get_sensitive())
        self.next.set_visible(self.page > 0 or self.next.get_sensitive())
        if target.paged:
            self.footer.set_text(f"Page {self.page + 1} · bytes {self.offsets[self.page]:,}–{self.result.get('nextOffset', 0):,} of {self.result.get('size', 0):,}" + (' · Limited evidence' if self.result.get('truncated') else ''))
        else:
            self.footer.set_text('Observed ' + observed(self.result.get('observedAt')) if self.result.get('observedAt') else 'Recorded runtime evidence · Reload to refresh')
        clear(self.related)
        if target.method == 'history.read':
            run_id = self.result.get('run', {}).get('id')
            if self.result.get('outputAvailable'):
                self.link('Recorded output', 'artifact.read', {'run': run_id}, True)
            for item in self.result.get('related', []):
                if item['kind'] in ('activity', 'run'):
                    self.link(item['label'], 'activity.list' if item['kind'] == 'activity' else 'history.read', {'run': item['id']})
                elif item['kind'] == 'checkpoint':
                    self.related.append(button(item['label'], lambda selected=item['id']: self.owner.checkpoints(selected)))
        if target.method == 'activity.list':
            seen = set()
            for item in self.result.get('activities', []):
                for path in item.get('metadata', {}).get('files', []):
                    if safe_file(path) and path not in seen and len(seen) < 12:
                        seen.add(path)
                        self.link(path, 'files.read', {'path': path}, True)
        if target.method == 'state.inspect':
            for run in self.result.get('runs', [])[:20]:
                self.link(run.get('title', 'Instruction')[:70], 'history.read', {'run': run['id']})
        if target.method == 'context.inspect':
            self.link('Retained history', 'context.history', {'conversation': self.owner.conversation}, True)
            self.related.append(button('Conversation memory', self.owner.memory))
        self.related.set_visible(self.related.get_first_child() is not None)
        if self.search.get_visible() and self.search.get_text():
            self.find(False, reset=True)

    def link(self, title, method, params, paged=False):
        self.related.append(button(title, lambda: self.owner.show_walkthrough(params['run']) if method == 'activity.list' and hasattr(self.owner, 'show_walkthrough') else self.open(title, method, params, paged)))

    def jump_declaration(self, *_):
        selected = self.outline.get_active_id()
        if selected and selected != 'none':
            result = self.view.get_buffer().get_iter_at_line(int(selected))
            iterator = result[-1] if isinstance(result, tuple) else result
            self.view.get_buffer().place_cursor(iterator)
            self.view.scroll_to_iter(iterator, .15, False, 0, 0)
            self.view.grab_focus()

    def focus_find(self):
        self.search.set_visible(True)
        self.search.grab_focus()

    def hide_find(self):
        self.search.set_visible(False)
        self.find_status.set_text('')
        self.find_status.set_visible(False)
        self.view.grab_focus()

    def find(self, backwards=False, reset=False):
        needle = self.search.get_text()
        if not needle:
            self.find_status.set_text('')
            self.find_status.set_visible(False)
            return
        self.find_status.set_visible(True)
        buffer = self.view.get_buffer()
        bounds = buffer.get_selection_bounds()
        origin = buffer.get_start_iter() if reset else (bounds[0 if backwards else 1] if bounds else buffer.get_iter_at_mark(buffer.get_insert()))
        flags = Gtk.TextSearchFlags.CASE_INSENSITIVE | Gtk.TextSearchFlags.TEXT_ONLY
        found = origin.backward_search(needle, flags, None) if backwards else origin.forward_search(needle, flags, None)
        wrapped = False
        if not found:
            origin = buffer.get_end_iter() if backwards else buffer.get_start_iter()
            found = origin.backward_search(needle, flags, None) if backwards else origin.forward_search(needle, flags, None)
            wrapped = True
        if found:
            start, end = found
            buffer.select_range(start, end)
            self.view.scroll_to_iter(start, .15, False, 0, 0)
            self.find_status.set_text('Wrapped to the other end of this page' if wrapped else 'Match in this page')
        else:
            self.find_status.set_text('No matches in this page')
