"""Bounded project navigation for the docked Inspect and Changes surfaces."""
from pathlib import PurePosixPath
from gi.repository import Gtk, Pango
from .navigation import matches, safe_file
from .presentation import humanize, observed
from .widgets import EmbeddedPanel, box, button, clear, icon_button, label, scroll


class ContextBrowser(EmbeddedPanel):
    def __init__(self, owner):
        super().__init__(owner, 'Workspace browser')
        self.mode, self.directory, self.offset = 'files', '.', 0
        self.cursor, self.trail, self.result = None, [], {}
        self.entries, self.loading = [], False
        self.git_problem, self.initializing = None, False
        self.loaded = False
        self.on_open = None
        navigation = box(False, spacing=6)
        self.home = icon_button('user-home-symbolic', 'Project root', lambda: self.folder('.'))
        self.up = icon_button('go-up-symbolic', 'Parent folder', self.parent_folder)
        navigation.append(self.home)
        navigation.append(self.up)
        self.location = label('Project files', 'heading')
        self.location.set_wrap(False)
        self.location.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        self.location.set_hexpand(True)
        navigation.append(self.location)
        navigation.append(icon_button('view-refresh-symbolic', 'Reload this list', self.reload))
        self.body.append(navigation)
        filters = box(False, spacing=6)
        self.query = Gtk.SearchEntry(placeholder_text='Filter this folder…', hexpand=True)
        self.query.connect('changed', self.query_changed)
        filters.append(self.query)
        self.scope = Gtk.ComboBoxText()
        for key, title in [('all', 'All changes'), ('working', 'Working tree'), ('staged', 'Staged'), ('conflicts', 'Conflicts')]:
            self.scope.append(key, title)
        self.scope.set_active_id('all')
        self.scope.connect('changed', lambda *_: self.render())
        filters.append(self.scope)
        self.body.append(filters)
        self.items = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE, activate_on_single_click=False)
        self.items.connect('row-activated', lambda _, row: self.activate(row))
        self.query.connect('activate', lambda *_: self.activate(self.items.get_selected_row()))
        self.list_scroll = scroll(self.items)
        self.body.append(self.list_scroll)
        git_content = box(spacing=12)
        self.git_setup = scroll(git_content)
        self.git_setup.set_visible(False)
        self.git_title = label('', 'heading')
        self.git_description = label('')
        self.git_description.set_max_width_chars(38)
        git_content.append(self.git_title)
        git_content.append(self.git_description)
        self.initialize = button('Initialize repository', self.initialize_repository)
        self.initialize.set_tooltip_text('Create a local Git repository on branch main. Files stay uncommitted.')
        git_content.append(self.initialize)
        git_content.append(button('Open another project…', lambda: self.owner.get_application().choose_folder(self.owner)))
        git_content.append(button('Retry', self.reload))
        self.git_details = Gtk.Expander(label='Git details')
        self.git_detail_text = label('')
        self.git_detail_text.set_max_width_chars(38)
        self.git_details.set_child(self.git_detail_text)
        git_content.append(self.git_details)
        self.body.append(self.git_setup)
        self.message = label('Open a folder or file to inspect its saved contents.', 'dim-label')
        self.body.append(self.message)
        paging = box(False, spacing=6)
        self.previous = button('Previous', lambda: self.page(-1))
        self.next = button('Next', lambda: self.page(1))
        self.all_diff = button('Working diff', self.open_full_diff)
        self.all_diff.set_tooltip_text('Compare tracked working tree changes. Open untracked files individually to preview them.')
        for widget in (self.previous, self.next, self.all_diff):
            paging.append(widget)
        self.body.append(paging)
        self.timer = None
        self.configure('files', load=False)

    def configure(self, mode, load=True):
        changed = mode != self.mode
        self.mode = mode
        if changed:
            self.offset, self.cursor, self.trail, self.result = 0, None, [], {}
            self.gate.issue('listing')
            self.query.set_text('')
            self.loaded = False
        self.home.set_visible(mode == 'files')
        self.up.set_visible(mode == 'files')
        self.scope.set_visible(mode == 'changes')
        self.all_diff.set_visible(mode == 'changes' and self.scope.get_active_id() != 'conflicts')
        self.query.set_placeholder_text('Filter this folder…' if mode == 'files' else 'Filter this list…')
        if load and (changed or not self.loaded):
            self.reload()

    def folder(self, directory):
        if directory != '.' and not safe_file(directory):
            self.show_error('Select a folder inside this project.')
            return
        self.directory, self.offset = directory, 0
        self.query.set_text('')
        self.reload()

    def parent_folder(self):
        self.folder(str(PurePosixPath(self.directory).parent))

    def query_changed(self, *_):
        if self.mode != 'files':
            self.render()
            return
        self.gate.issue('listing')
        self.entries = []
        clear(self.items)
        self.loading = True
        self.previous.set_sensitive(False)
        self.next.set_sensitive(False)
        if self.timer:
            from gi.repository import GLib
            GLib.source_remove(self.timer)
            self.timers.discard(self.timer)
        from gi.repository import GLib
        def run():
            self.timers.discard(self.timer)
            self.timer = None
            self.offset = 0
            self.reload()
            return False
        self.timer = GLib.timeout_add(180, run)
        self.timers.add(self.timer)

    def reload(self):
        if self.initializing:
            return
        if self.timer:
            from gi.repository import GLib
            GLib.source_remove(self.timer)
            self.timers.discard(self.timer)
            self.timer = None
        self.loading = True
        self.git_problem = None
        self.git_setup.set_visible(False)
        self.list_scroll.set_visible(True)
        self.query.set_sensitive(self.mode != 'changes')
        self.scope.set_sensitive(False)
        self.all_diff.set_sensitive(False)
        self.entries = []
        clear(self.items)
        self.message.set_text('Loading…')
        self.previous.set_sensitive(False)
        self.next.set_sensitive(False)
        if self.mode == 'files':
            method, params = 'files.list', {'path': self.directory, 'offset': self.offset, 'query': self.query.get_text()[:200]}
            self.location.set_text('Project files' if self.directory == '.' else self.directory)
            self.up.set_sensitive(self.directory != '.')
        elif self.mode == 'changes':
            method, params = 'changes.list', {}
            self.location.set_text('Project changes')
        else:
            method, params = 'history.list', {'cursor': self.cursor} if self.cursor else {}
            self.location.set_text('Recorded instructions')
        self.location.set_tooltip_text(self.location.get_text())
        def loaded(result):
            self.loading, self.loaded, self.result = False, True, result
            self.query.set_sensitive(True)
            self.scope.set_sensitive(True)
            self.all_diff.set_sensitive(self.mode == 'changes')
            self.entries = result.get('entries', result.get('runs', []))
            self.render()
        def failed(error):
            # A failed attempt is still complete. Keep its recovery actions
            # stable until an explicit retry, rather than polling every tick.
            self.loading, self.loaded, self.result = False, True, {}
            if self.mode == 'changes':
                self.show_git_problem(error)
            else:
                self.message.set_text('Unable to load this list. Use Reload to try again.')
                self.show_error(error)
        self.request(method, params, loaded, failed, lane='listing')

    def show_git_problem(self, error):
        self.git_problem = str(error)
        code, _, description = self.git_problem.partition(': ')
        missing = code == 'GIT_NOT_REPOSITORY'
        titles = {'GIT_UNAVAILABLE': 'Git is unavailable', 'GIT_OWNERSHIP': 'Check project ownership',
                  'GIT_REPOSITORY_INVALID': 'Git metadata needs attention', 'GIT_NO_WORKTREE': 'Open a working checkout',
                  'GIT_PERMISSION': 'Check project permissions', 'GIT_TIMEOUT': 'Git did not respond',
                  'GIT_STATUS_LIMIT': 'Too many changes to load', 'GIT_PATH_ENCODING': 'Unsupported filename encoding',
                  'GIT_OBJECT_UNAVAILABLE': 'Git history is incomplete', 'GIT_OUTPUT_LIMIT': 'Git output is too large'}
        self.git_title.set_text('Start tracking changes' if missing else titles.get(code, 'Could not load changes'))
        self.git_description.set_text('This project is not using Git yet. Initialize a local repository on branch main, then review your changes here. Your files stay uncommitted.' if missing else description.split('\n\n')[0] if code.startswith('GIT_') else 'Git could not read this project. Review the details, then retry.')
        self.git_detail_text.set_text(self.git_problem[:2400])
        self.git_details.set_expanded(False)
        self.git_setup.set_visible(True)
        self.list_scroll.set_visible(False)
        self.initialize.set_visible(missing and 'repository-initialize-v1' in getattr(self.client, 'capabilities', set()))
        self.initialize.set_sensitive(not self.initializing)
        self.query.set_sensitive(False)
        self.scope.set_sensitive(False)
        self.all_diff.set_sensitive(False)
        self.previous.set_visible(False)
        self.next.set_visible(False)
        self.message.set_text('Project files remain available in Inspect.')
        self.error.set_visible(False)

    def initialize_repository(self):
        if (self.mode != 'changes' or self.initializing or not self.git_problem or
                not self.git_problem.startswith('GIT_NOT_REPOSITORY:') or
                'repository-initialize-v1' not in getattr(self.client, 'capabilities', set()) or not self.valid_scope()):
            return
        self.initializing = True
        self.initialize.set_sensitive(False)
        self.initialize.set_label('Initializing…')
        def done(result=None, error=None):
            self.initializing = False
            self.initialize.set_label('Initialize repository')
            if self.mode == 'changes':
                if error:
                    self.show_git_problem(error)
                else:
                    self.reload()
            elif not self.loaded:
                self.reload()
        self.request('repository.initialize', {}, done, lambda error: done(error=error), lane='initialize')

    def render(self):
        selected = self.items.get_selected_row()
        identity = selected.entry.get('path', selected.entry.get('id')) if selected else None
        clear(self.items)
        if self.loading:
            return
        if self.mode == 'changes' and self.git_problem:
            return
        count, conflicts = 0, 0
        scope = self.scope.get_active_id()
        self.all_diff.set_visible(self.mode == 'changes' and scope != 'conflicts')
        self.all_diff.set_label('Staged diff' if scope == 'staged' else 'Working diff')
        self.all_diff.set_tooltip_text('Compare all staged changes.' if scope == 'staged' else 'Compare tracked working tree changes. Open untracked files individually to preview them.')
        for entry in self.entries:
            if self.mode != 'files' and not matches(self.query.get_text(), entry.get('path', ''), entry.get('text', ''), entry.get('state', '')):
                continue
            if self.mode == 'changes' and ((scope == 'staged' and not entry.get('staged')) or (scope == 'working' and not entry.get('unstaged')) or (scope == 'conflicts' and not entry.get('conflicted'))):
                continue
            row = Gtk.ListBoxRow()
            row.entry = entry
            content = box(False, spacing=8, margin=6)
            content.append(Gtk.Image(icon_name='folder-symbolic' if entry.get('directory') else 'text-x-generic-symbolic'))
            words = box(spacing=2)
            words.set_hexpand(True)
            title = label(entry.get('name', entry.get('text', 'Instruction')))
            title.set_wrap(False)
            title.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
            title.set_selectable(False)
            words.append(title)
            detail = ''
            if self.mode == 'changes':
                detail = ('Merge conflict' if entry.get('conflicted') else 'Untracked' if entry.get('untracked') else 'Staged + working tree' if entry.get('staged') and entry.get('unstaged') else 'Staged' if entry.get('staged') else 'Working tree') + ' · ' + entry['path']
                conflicts += bool(entry.get('conflicted'))
            elif self.mode == 'runs':
                detail = humanize(entry.get('state')) + ' · ' + observed(entry.get('createdAt'))
            elif entry.get('symlink'):
                detail = 'Symbolic link · project boundary checked when opened'
            if detail:
                secondary = label(detail, 'dim-label')
                secondary.set_wrap(False)
                secondary.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
                secondary.set_selectable(False)
                words.append(secondary)
            content.append(words)
            row.set_child(content)
            row.set_tooltip_text(entry.get('path', entry.get('text', '')) + '\n' + detail)
            self.items.append(row)
            if entry.get('path', entry.get('id')) == identity:
                self.items.select_row(row)
            count += 1
        if self.mode == 'files':
            self.message.set_text((f"{self.offset + 1}–{self.offset + count} of {self.result.get('matched', count)}" if count else 'No matching files in this folder.' if self.query.get_text() else 'This folder is empty.') + (' · Scan limited; choose a subfolder.' if self.result.get('scanLimited') else ''))
        elif self.mode == 'changes':
            paths = f'{count} path' + ('s' if count != 1 else '')
            summary = f'{paths} · Includes existing and external edits.' if count else 'No changes match this view.' if self.query.get_text() else 'No merge conflicts.' if scope == 'conflicts' else 'No changes in this scope.'
            if conflicts:
                summary = (f'{paths} · ' if scope != 'conflicts' else '') + f'{conflicts} merge conflict' + ('s.' if conflicts != 1 else '.') + ' Select a path to review; resolve it in your editor.'
            self.message.set_text(' · '.join(part for part in (self.result.get('branch', ''), summary) if part))
            if self.result.get('limited'):
                self.message.set_text(self.message.get_text() + f' List limited to {len(self.entries)} paths; use Git for the complete list.')
        else:
            self.message.set_text(f'{count} recorded instructions on this page · No automatic resume')
        self.previous.set_sensitive(self.offset > 0 if self.mode == 'files' else bool(self.trail) if self.mode == 'runs' else False)
        self.next.set_sensitive(bool(self.result.get('more')) if self.mode == 'files' else bool(self.result.get('nextCursor')) if self.mode == 'runs' else False)
        paged = self.previous.get_sensitive() or self.next.get_sensitive()
        self.previous.set_visible(paged)
        self.next.set_visible(paged)

    def page(self, direction):
        if self.loading or not (self.next if direction > 0 else self.previous).get_sensitive():
            return
        if self.mode == 'files':
            self.offset = self.result['nextOffset'] if direction > 0 else max(0, self.offset - 100)
        elif self.mode == 'runs':
            if direction > 0:
                self.trail = (self.trail + [self.cursor])[-128:]
                self.cursor = self.result['nextCursor']
            else:
                self.cursor = self.trail.pop()
        self.reload()

    def activate(self, row):
        if not row or self.loading or self.timer or not self.valid_scope() or row.get_parent() is not self.items:
            return
        entry = row.entry
        path = entry.get('path', '')
        if self.mode == 'runs':
            self.owner.evidence('Run details', 'history.read', {'run': entry['id']})
        elif self.mode == 'files' and entry.get('directory'):
            self.folder(path)
        elif safe_file(path):
            if self.mode == 'changes' and not entry.get('untracked'):
                staged = not entry.get('conflicted') and (self.scope.get_active_id() == 'staged' or (self.scope.get_active_id() == 'all' and not entry.get('unstaged')))
                self.owner.evidence(path, 'changes.read', {'path': path, 'staged': staged}, True)
            else:
                self.owner.evidence(path, 'files.read', {'path': path}, True)

    def open_full_diff(self):
        if self.loading or self.git_problem or not self.loaded or self.mode != 'changes' or self.scope.get_active_id() == 'conflicts' or not self.valid_scope():
            return
        self.owner.evidence('Staged changes' if self.scope.get_active_id() == 'staged' else 'Working tree changes', 'changes.read', {'staged': self.scope.get_active_id() == 'staged'}, True)
