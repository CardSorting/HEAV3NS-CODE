"""GTK 4 desktop shell. All agent operations belong to the shared Node worker."""
import json
from pathlib import Path
import queue
import signal
import sys
import threading
import time
import uuid

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango

from .state import StateStore, authorization_url, preview_url
from .transport import RuntimeClient, RuntimeRejected


from .widgets import box, label, button, scroll, clear, text_value, text_view, describe, Panel
from .navigation import matches
from .inspector import Inspector
from .pickers import CommandPalette, QuickOpen
from .pods import Pods
from .approval import ApprovalView
from .workspace_commands import WorkspaceCommands
from .transcript import RunRow
from .task_context import TaskContext


class Workspace(Gtk.ApplicationWindow):
    def __init__(self, app, folder):
        super().__init__(application=app, title=f"{Path(folder).name} — HEAV3NS-CODE",
                         default_width=1440, default_height=860)
        self.folder, self.app = folder, app
        self.store = app.store
        self.key = self.store.workspace_key(folder)
        self.saved = self.store.read(self.key, {})
        self.layout_preferences = {"sidebar": True, "context": True, "width": 440, "tab": "walkthrough", **self.saved.get("layout", {})}
        self.compact_context = False
        self.compact_sidebar = False
        self.last_layout = None
        self.applying_layout = False
        self.drafts = self.saved.get("drafts", {})
        self.continuations = self.saved.get("continuations", {})
        self.pending_submission = self.saved.get("pending")
        self.conversation = ""
        self.runs = {}
        self.client = None
        self.panels = set()
        self.inspector = None
        self.palette = None
        self.quick_open = None
        self.conversation_load = 0
        self.history_loading = False
        self.closed = False
        self.switching = False
        self.submitting = False
        self.continuation = None
        self.snapshot_pending = False
        self.dirty = False
        self.seq = 0
        self.reconciling = False
        self.connected_once = False
        self.last_transcript = None
        self.last_conversations = None
        self.persist_source = None
        self.commands = WorkspaceCommands(self)
        self.header = Gtk.HeaderBar()
        self.header.pack_start(button("Projects", app.show_library))
        self.header.pack_start(button("Conversations", self.toggle_sidebar))
        self.header.pack_end(button("Actions", self.show_tools))
        self.context_button = Gtk.ToggleButton(label="Context")
        self.context_button.set_tooltip_text("Show task context (Ctrl+Alt+B)")
        self.context_button.connect("toggled", lambda *_: self.toggle_context() if not self.applying_layout else None)
        self.header.pack_end(self.context_button)
        self.header.pack_end(button("Pods", app.show_pods))
        self.models_button = button("Models", self.models)
        self.header.pack_end(self.models_button)
        self.set_titlebar(self.header)
        outer = box(spacing=0)
        self.status = label("Connecting to LUMI…")
        self.status.set_wrap(False)
        self.status.set_ellipsize(Pango.EllipsizeMode.END)
        self.status.set_margin_start(18)
        self.status.set_margin_end(18)
        outer.append(self.status)
        self.error_bar = box(False, margin=10)
        self.error_label = label("", "error")
        self.error_label.set_hexpand(True)
        self.error_bar.append(self.error_label)
        self.error_bar.append(button("Dismiss", lambda: self.error_bar.set_visible(False)))
        self.error_bar.set_visible(False)
        outer.append(self.error_bar)
        self.state_recovery = button("Review saved desktop state…", lambda: app.review_state(self, self.key, self.state_recovered))
        self.state_recovery.set_visible(self.key in self.store.problems)
        outer.append(self.state_recovery)
        self.reconnect = button("Reconnect", self.connect_runtime)
        self.reconnect.set_visible(False)
        self.connection_details = button("Connection details…", self.show_connection_details)
        self.connection_details.set_visible(False)
        connection_actions = box(False, spacing=6)
        self.reconnect.set_hexpand(True)
        connection_actions.append(self.reconnect)
        connection_actions.append(self.connection_details)
        outer.append(connection_actions)
        self.layout = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL, vexpand=True)
        self.layout.set_position(225)
        self.sidebar = box(margin=14)
        self.sidebar.set_size_request(180, -1)
        self.new_conversation = button("New conversation", lambda: self.change_conversation("conversation.create", {}))
        self.sidebar.append(self.new_conversation)
        self.conversation_search = Gtk.SearchEntry(placeholder_text="Filter loaded conversations")
        self.conversation_search.connect("search-changed", lambda *_: self.filter_conversations())
        self.sidebar.append(self.conversation_search)
        self.conversation_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.conversation_list.connect("row-activated", self.select_conversation)
        self.sidebar.append(scroll(self.conversation_list))
        self.conversation_more = button("More conversations", lambda: self.load_conversations(self.conversation_offset + 100))
        self.conversation_offset = 0
        self.sidebar.append(self.conversation_more)
        self.delete_conversation = button("Delete conversation…", self.delete_current)
        self.sidebar.append(self.delete_conversation)
        self.layout.set_start_child(self.sidebar)
        center = box(margin=20)
        self.title = label("Conversation", "title-2")
        self.title.set_lines(2)
        self.title.set_ellipsize(Pango.EllipsizeMode.END)
        center.append(self.title)
        self.transcript = box(spacing=20)
        self.transcript_rows = {}
        self.transcript_scroll = scroll(self.transcript)
        center.append(self.transcript_scroll)
        history_actions = box(False)
        self.older = button("Earlier instructions", self.earlier)
        self.history_cursor = None
        history_actions.append(self.older)
        history_actions.append(button("Latest", self.to_latest))
        center.append(history_actions)
        self.approval_view = ApprovalView(self)
        self.approval_box = self.approval_view.view
        self.approval_box.add_css_class("card")
        self.approval_box.set_visible(False)
        center.append(self.approval_box)
        self.composer = text_view(editable=True)
        self.composer.update_property([Gtk.AccessibleProperty.LABEL], ["Message LUMI"])
        self.composer.set_tooltip_text("Describe what you want LUMI to do. Ctrl+Enter sends; Enter starts a new line.")
        self.composer.get_buffer().connect("changed", self.draft_changed)
        composer_scroll = scroll(self.composer, False)
        composer_scroll.set_min_content_height(100)
        composer_scroll.set_max_content_height(180)
        composer_scroll.add_css_class("frame")
        center.append(composer_scroll)
        self.continuation_control = button("Continuing saved work · Cancel continuation", self.cancel_continuation)
        self.continuation_control.set_visible(False)
        center.append(self.continuation_control)
        actions = box(False)
        self.model_label = label("Loading model…", "dim-label")
        self.model_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        self.model_label.set_wrap(False)
        self.model_label.set_hexpand(True)
        actions.append(self.model_label)
        self.stop = button("Stop all", self.commands.stop)
        actions.append(self.stop)
        self.send = button("Send", self.submit, "suggested-action")
        actions.append(self.send)
        center.append(actions)
        self.center = center
        self.context_split = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL, wide_handle=True)
        self.context_split.set_start_child(center)
        self.task_context = TaskContext(self)
        self.context_split.set_end_child(self.task_context)
        self.context_split.set_resize_end_child(False)
        self.context_split.set_shrink_start_child(True)
        self.context_split.set_shrink_end_child(False)
        self.context_split.connect("notify::position", self.context_resized)
        self.layout.set_end_child(self.context_split)
        self.layout.set_resize_start_child(False)
        outer.append(self.layout)
        self.set_child(outer)
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.key_pressed)
        self.add_controller(keys)
        self.connect("close-request", self.close_workspace)
        self.connect_runtime()
        GLib.timeout_add(100, self.tick)
        self.present()
        self.composer.grab_focus()

    def key_pressed(self, controller, key, code, state):
        if key == Gdk.KEY_F1:
            self.show_tools()
            return True
        if state & Gdk.ModifierType.CONTROL_MASK:
            shift = bool(state & Gdk.ModifierType.SHIFT_MASK)
            if key == Gdk.KEY_Return:
                self.submit()
                return True
            if key in (Gdk.KEY_p, Gdk.KEY_P):
                self.show_tools() if shift else self.files()
                return True
            if key in (Gdk.KEY_o, Gdk.KEY_O):
                self.app.choose_folder(self)
                return True
            if key in (Gdk.KEY_n, Gdk.KEY_N):
                self.change_conversation("conversation.create", {})
                return True
            if key in (Gdk.KEY_b, Gdk.KEY_B):
                self.toggle_context() if state & Gdk.ModifierType.ALT_MASK else self.toggle_sidebar()
                return True
            if key in (Gdk.KEY_l, Gdk.KEY_L):
                self.show_conversation()
                self.composer.grab_focus()
                return True
            if key in (Gdk.KEY_f, Gdk.KEY_F):
                self.show_conversation()
                self.compact_sidebar = True
                self.layout_preferences["sidebar"] = True
                self.adapt_layout(force=True)
                self.conversation_search.grab_focus()
                return True
        return False

    def invalidate_panels(self):
        for panel in list(self.panels):
            panel.invalidate()
        self.inspector = None

    def filter_conversations(self):
        row = self.conversation_list.get_first_child()
        while row:
            row.set_visible(matches(self.conversation_search.get_text(), row.conversation_title))
            row = row.get_next_sibling()

    def toggle_sidebar(self):
        if self.get_width() < 1140:
            self.compact_sidebar = not self.sidebar.get_visible()
            self.compact_context = False
        else:
            self.layout_preferences['sidebar'] = not self.sidebar.get_visible()
        self.adapt_layout(force=True)
        self.draft_changed()

    def toggle_context(self):
        show = not self.task_context.get_visible()
        if self.get_width() < 1140:
            self.compact_context = show
        else:
            self.layout_preferences['context'] = show
        self.adapt_layout(force=True)
        self.draft_changed()

    def hide_context(self):
        self.compact_context = False
        self.layout_preferences['context'] = False
        self.adapt_layout(force=True)
        self.show_conversation()
        self.draft_changed()

    def show_conversation(self):
        self.compact_context = False
        self.adapt_layout(force=True)
        self.composer.grab_focus()

    def show_context(self, tab=None):
        self.layout_preferences['context'] = True
        self.compact_context = True
        self.adapt_layout(force=True)
        if tab:
            self.task_context.select(tab)
        self.task_context.update()

    def review_approval(self):
        self.show_conversation()
        if self.approval_box.get_visible():
            self.approval_box.child_focus(Gtk.DirectionType.TAB_FORWARD)

    def show_walkthrough(self, identity=None):
        self.show_context('walkthrough')
        if identity:
            self.task_context.walkthrough.pin(identity)

    def context_resized(self, *_):
        if self.applying_layout or not self.task_context.get_visible() or self.get_width() < 1140:
            return
        width = self.context_split.get_width() - self.context_split.get_position()
        if 370 <= width <= 720 and width != self.layout_preferences['width']:
            self.layout_preferences['width'] = width
            self.draft_changed()

    def adapt_layout(self, force=False):
        width = self.get_width()
        if width <= 0:
            return
        compact = width < 1140
        state = (width, self.compact_context, self.compact_sidebar, self.layout_preferences['sidebar'], self.layout_preferences['context'])
        if state == self.last_layout and not force:
            return
        self.last_layout = state
        self.applying_layout = True
        show_context = self.compact_context if compact else self.layout_preferences['context']
        self.center.set_visible(not compact or not show_context)
        self.task_context.set_visible(show_context)
        self.sidebar.set_visible((self.compact_sidebar and not show_context) if compact else self.layout_preferences['sidebar'])
        self.context_button.set_active(show_context)
        if show_context and not compact:
            available = width - (self.layout.get_position() if self.sidebar.get_visible() else 0)
            self.context_split.set_position(max(360, available - self.layout_preferences['width']))
        self.applying_layout = False


    def rpc(self, method, params=None, callback=None, error=None):
        if not self.client or self.client.closed:
            (error or self.show_error)("LUMI is disconnected. Reconnect to continue.")
            return
        client = self.client
        future = client.request(method, params)
        def deliver():
            if self.closed or self.client is not client:
                return False
            try:
                value = future.result()
            except Exception as exc:
                (error or self.show_error)(exc)
            else:
                if callback:
                    callback(value)
            return False
        future.add_done_callback(lambda _: GLib.idle_add(deliver))

    def connect_runtime(self):
        if self.client and self.client.process.poll() is None:
            self.show_error("The previous worker is still stopping. Try Reconnect again in a moment.")
            return
        self.invalidate_panels()
        self.reconnect.set_visible(False)
        self.connection_details.set_visible(False)
        self.status.set_text("Connecting to LUMI…")
        self.send.set_sensitive(False)
        self.stop.set_sensitive(False)
        self.snapshot_pending = False
        self.history_loading = False
        self.switching = False
        self.submitting = False
        self.connected_once = False
        self.reconciling = False
        try:
            self.client = RuntimeClient(self.folder)
        except Exception as exc:
            self.show_error(exc)
            self.reconnect.set_visible(True)
            return
        client = self.client
        def connect():
            try:
                snapshot = client.connect()
                GLib.idle_add(self.attached, client, snapshot)
            except Exception as exc:
                client.fail(str(exc))
        threading.Thread(target=connect, daemon=True).start()

    def attached(self, client, snapshot):
        if self.closed or client is not self.client or client.closed:
            return False
        self.connected_once = True
        self.runs = {}
        self.render_snapshot(snapshot)
        self.load_conversations()
        self.reconcile_pending()
        self.update_controls()
        return False

    def reconcile_pending(self):
        pending = self.pending_submission
        if not pending or self.reconciling:
            return
        if pending.get("session") == self.client.session and pending.get("conversation") == self.conversation:
            self.reconciling = True
            def failed(error):
                self.reconciling = False
                self.show_error(error)
            self.rpc("task.lookup", {"request": pending["id"]}, self.reconciled, failed)
        else:
            self.show_error("An earlier submission needs review in its original conversation before you resend it.")

    def reconciled(self, result):
        self.reconciling = False
        pending = self.pending_submission
        if result.get("found"):
            if text_value(self.composer) == pending.get("text"):
                self.composer.get_buffer().set_text("")
            self.status.set_text("Recovered the accepted instruction. It was not sent again.")
        else:
            self.status.set_text("The previous instruction was not accepted. Your draft is ready to send.")
        self.pending_submission = None
        if result.get("found"):
            self.continuation = None
        self.persist()
        self.update_controls()
        self.refresh()

    def tick(self):
        if self.closed:
            return False
        if self.client:
            if self.client.closed:
                self.status.set_text((self.client.failure or "Disconnected").split('\n')[0])
                self.reconnect.set_visible(True)
                self.connection_details.set_visible(True)
            else:
                for _ in range(16):
                    try:
                        event = self.client.events.get_nowait()
                    except queue.Empty:
                        break
                    if event.get("type") == "runtime.error":
                        self.show_error(event.get("payload", {}).get("message", "Runtime failed."))
                    # Coalesce progress into an authoritative snapshot. Never apply stale run deltas.
                    if event.get("seq", 0) > self.seq:
                        self.dirty = True
                if self.dirty and self.connected_once and not self.snapshot_pending and not self.switching:
                    self.dirty = False
                    self.refresh()
        self.update_controls()
        self.adapt_layout()
        self.task_context.update()
        return True

    def refresh(self):
        if self.snapshot_pending:
            self.dirty = True
            return
        self.snapshot_pending = True
        def loaded(value):
            self.snapshot_pending = False
            self.render_snapshot(value)
        def failed(error):
            self.snapshot_pending = False
            self.show_error(error)
        self.rpc("snapshot", {}, loaded, failed)

    def render_snapshot(self, snapshot):
        self.seq = snapshot.get("seq", 0)
        conversation = snapshot.get("conversation", self.client.session)
        if conversation != self.conversation:
            self.save_draft()
            self.invalidate_panels()
            self.conversation = conversation
            self.continuation = self.continuations.get(conversation)
            self.runs = {}
            clear(self.transcript)
            self.transcript_rows.clear()
            self.history_cursor = None
            self.last_transcript = None
            self.composer.get_buffer().set_text(self.drafts.get(conversation, ""))
            self.load_conversations()
            if self.pending_submission and not self.submitting:
                self.reconcile_pending()
        for run in snapshot.get("runs", []):
            if run.get("conversation", run.get("session")) == self.conversation:
                self.runs[run["id"]] = run
        self.active = snapshot.get("active")
        self.queued = snapshot.get("queued", [])
        self.model_state = snapshot.get("modelSelection", {})
        self.model_label.set_text(self.model_state.get("model", "Select a model"))
        self.model_label.set_tooltip_text(describe(self.model_state.get("provider", "")))
        self.render_runs()
        if not self.pending_submission:
            self.status.set_text("Working…" if self.active else "Ready · " + self.folder)
        self.update_controls()

    def render_runs(self):
        ordered = sorted(self.runs.values(), key=lambda run: (run.get("createdAt", 0), run["id"]))
        signature = json.dumps(ordered, sort_keys=True)
        if signature == self.last_transcript:
            return
        self.last_transcript = signature
        adjustment = self.transcript_scroll.get_vadjustment()
        position, upper = adjustment.get_value(), adjustment.get_upper()
        follow = position >= upper - adjustment.get_page_size() - 40
        first = self.transcript.get_first_child()
        previous_first = next((identity for identity, row in self.transcript_rows.items() if row.view is first), None)
        if not self.transcript_rows:
            clear(self.transcript)
        keep = {run["id"] for run in ordered}
        for identity in set(self.transcript_rows) - keep:
            self.transcript.remove(self.transcript_rows.pop(identity).view)
        if not ordered:
            self.transcript.append(label("What would you like to build?", "title-1"))
            self.transcript.append(label("Describe a change or ask a question. Open Actions for files, project tools and saved evidence.", "dim-label"))
        previous = None
        for run in ordered:
            row = self.transcript_rows.get(run["id"])
            if row is None:
                row = RunRow(self, run["id"])
                self.transcript_rows[run["id"]] = row
                self.transcript.insert_child_after(row.view, previous)
            row.update(run)
            previous = row.view
        prepended = bool(previous_first and ordered and ordered[0]["id"] != previous_first)
        generation = self.conversation
        def restore_position():
            if not self.closed and self.conversation == generation:
                adjustment.set_value(adjustment.get_upper() if follow else position + (adjustment.get_upper() - upper if prepended else 0))
            return False
        GLib.idle_add(restore_position)

    def update_controls(self):
        ready = bool(self.client and self.client.ready and not self.client.closed and self.connected_once)
        busy = bool(getattr(self, "active", None) or getattr(self, "queued", []))
        self.send.set_sensitive(ready and self.key not in self.store.problems and not self.switching and not self.submitting and not self.pending_submission
                                and bool(text_value(self.composer).strip())
                                and len(getattr(self, "queued", [])) < (self.client.queue_limit if self.client else 3))
        self.state_recovery.set_visible(self.key in self.store.problems)
        self.send.set_label("Queue" if busy else "Send")
        self.continuation_control.set_visible(bool(self.continuation))
        self.stop.set_sensitive(self.commands.can_stop())
        self.stop.set_label("Stopping…" if self.commands.stop_pending else "Stop all")
        self.approval_view.update()
        self.models_button.set_sensitive(ready and "model-selection-v1" in self.client.capabilities)
        conversations = ready and "conversations" in self.client.capabilities
        self.new_conversation.set_sensitive(conversations and not busy and not self.switching and not self.pending_submission)
        self.conversation_list.set_sensitive(conversations and not busy and not self.switching)
        self.delete_conversation.set_sensitive(conversations and not busy and not self.pending_submission)

    def state_recovered(self):
        self.state_recovery.set_visible(False)
        self.persist()
        self.update_controls()

    def show_error(self, error):
        self.error_label.set_text(str(error))
        self.error_bar.set_visible(True)

    def save_draft(self):
        if self.conversation:
            self.drafts[self.conversation] = text_value(self.composer)
            self.continuations[self.conversation] = self.continuation

    def persist(self):
        self.save_draft()
        try:
            self.store.write(self.key, {"drafts": self.drafts, "continuations": self.continuations, "pending": self.pending_submission, "layout": self.layout_preferences})
        except OSError as error:
            self.show_error("Could not save the draft: " + str(error))
            return False
        return True

    def draft_changed(self, *_):
        if self.persist_source:
            GLib.source_remove(self.persist_source)
        def save():
            self.persist_source = None
            self.persist()
            return False
        self.persist_source = GLib.timeout_add(400, save)
        self.update_controls()

    def submit(self):
        if not self.send.get_sensitive():
            return
        text = text_value(self.composer).strip()
        # JavaScript's protocol limit counts UTF-16 code units.
        if len(text.encode("utf-16-le")) // 2 > self.client.instruction_limit:
            self.show_error(f"Keep instructions within {self.client.instruction_limit:,} characters. Your draft is preserved.")
            return
        request_id = str(uuid.uuid4())
        self.pending_submission = {"id": request_id, "session": self.client.session,
                                   "conversation": self.conversation, "text": text_value(self.composer)}
        if not self.persist():
            self.pending_submission = None
            return
        self.submitting = True
        self.update_controls()
        client = self.client
        params = {"text": text, "conversation": self.conversation}
        if self.continuation:
            params["continueFrom"] = self.continuation
        future = client.request("task.submit", params, request_id)
        def complete():
            if self.closed or self.client is not client:
                return False
            self.submitting = False
            try:
                result = future.result()
                if text_value(self.composer) == self.pending_submission["text"]:
                    self.composer.get_buffer().set_text("")
                self.pending_submission = None
                self.continuation = None
                self.persist()
                self.refresh()
            except Exception as error:
                # Explicit rejection is safe to retry; transport failures require lookup.
                if isinstance(error, RuntimeRejected):
                    self.pending_submission = None
                    self.persist()
                self.show_error(error)
            self.update_controls()
            return False
        future.add_done_callback(lambda _: GLib.idle_add(complete))

    def load_conversations(self, offset=0):
        if not self.client or "conversations" not in self.client.capabilities:
            return
        self.conversation_offset = offset
        self.conversation_load += 1
        generation = self.conversation_load
        def loaded(result):
            if generation != self.conversation_load:
                return
            clear(self.conversation_list)
            for conversation in result.get("conversations", []):
                row = Gtk.ListBoxRow()
                row.conversation_id = conversation["id"]
                row.conversation_title = conversation.get("title") or "New conversation"
                title = label(conversation.get("title") or "New conversation")
                title.set_lines(2)
                title.set_ellipsize(Pango.EllipsizeMode.END)
                title.set_margin_top(10)
                title.set_margin_bottom(10)
                title.set_tooltip_text(title.get_text())
                row.set_child(title)
                self.conversation_list.append(row)
                if conversation["id"] == self.conversation:
                    self.conversation_list.select_row(row)
                    self.title.set_text(conversation.get("title") or "New conversation")
            self.filter_conversations()
            self.conversation_more.set_label("More conversations" if result.get("more") else "First conversations")
            self.conversation_more.set_sensitive(result.get("more", False) or offset > 0)
            if not result.get("more"):
                self.conversation_offset = -100
        self.rpc("conversation.list", {"offset": offset}, loaded)

    def select_conversation(self, widget, row):
        if row.conversation_id != self.conversation:
            self.change_conversation("conversation.select", {"id": row.conversation_id})

    def change_conversation(self, method, params):
        if (self.switching or self.submitting or not self.client or not self.client.ready
                or getattr(self, "active", None) or getattr(self, "queued", [])):
            return
        if not self.persist():
            return
        self.switching = True
        self.update_controls()
        # Wait until an earlier snapshot has completed before the mutation.
        def begin():
            if self.closed:
                return False
            if self.snapshot_pending:
                return True
            def changed(_):
                self.snapshot_pending = True
                def switched(snapshot):
                    self.snapshot_pending = False
                    self.switching = False
                    self.render_snapshot(snapshot)
                    self.load_conversations()
                def snapshot_failed(error):
                    self.snapshot_pending = False
                    self.switching = False
                    self.client.fail("Conversation changed but could not be reconciled. Reconnect to recover its saved state.")
                    self.show_error(error)
                self.rpc("snapshot", {}, switched, snapshot_failed)
            def failed(error):
                self.switching = False
                self.show_error(error)
                self.update_controls()
            self.rpc(method, params, changed, failed)
            return False
        GLib.timeout_add(50, begin)

    def delete_current(self):
        self.confirm("Delete this conversation?", "Its conversation entry will be removed. Project files are retained.",
                     lambda: self.change_conversation("conversation.delete", {"id": self.conversation}), "Delete")

    def confirm(self, title, detail, action, confirm="Continue"):
        panel = Panel(self, title, 520, 280)
        panel.body.append(scroll(label(detail)))
        controls = box(False)
        controls.append(button("Cancel", panel.destroy))
        controls.append(button(confirm, lambda: (panel.destroy(), action()) if panel.valid_scope() else panel.invalidate(), "destructive-action"))
        panel.body.append(controls)
        panel.present()

    def earlier(self):
        if self.history_loading:
            return
        self.history_loading = True
        conversation = self.conversation
        def loaded(result):
            self.history_loading = False
            if self.conversation != conversation:
                return
            for run in result.get("runs", []):
                self.runs[run["id"]] = run
            self.history_cursor = result.get("cursor") or result.get("nextCursor")
            self.older.set_sensitive(bool(self.history_cursor))
            self.render_runs()
        self.rpc("history.list", {"cursor": self.history_cursor} if self.history_cursor else {}, loaded, lambda error: (setattr(self, "history_loading", False), self.show_error(error)))

    def to_latest(self):
        adjustment = self.transcript_scroll.get_vadjustment()
        adjustment.set_value(adjustment.get_upper())

    def evidence(self, title, method, params=None, paged=False):
        if method == 'activity.list':
            self.show_walkthrough((params or {}).get('run'))
            return self.task_context.walkthrough
        self.task_context.update()
        self.inspector = self.task_context.inspector
        return self.inspector.open(title, method, params or {}, paged)

    def cancel_continuation(self):
        self.continuation = None
        self.persist()
        self.update_controls()

    def prepare_continuation(self, run):
        if text_value(self.composer).strip():
            self.show_error("Send or clear your current draft before preparing a continuation.")
            return
        self.continuation = {"run": run["id"], "revision": run["revision"]}
        self.composer.get_buffer().set_text("Continue the previous instruction from its saved state. Review what remains before making further changes.")
        self.composer.grab_focus()
        self.status.set_text("Continuation prepared. Review the draft and press Send to continue.")

    def edit_queued(self, run):
        panel = Panel(self, "Edit queued instruction")
        editor = text_view(True)
        editor.get_buffer().set_text(run.get("text", ""))
        panel.body.append(scroll(editor))
        panel.body.append(button("Save", lambda: panel.request("task.edit", {"run": run["id"], "revision": run["revision"],
                                  "text": text_value(editor)}, lambda _: (panel.destroy(), self.refresh()), panel.show_error)))
        panel.present()

    def actions(self):
        ready = bool(self.client and self.client.ready and not self.client.closed and self.connected_once)
        idle = ready and not getattr(self, "active", None) and not getattr(self, "queued", []) and not self.switching and not self.pending_submission
        specs = [
            ("context-panel", "Toggle task context", "Ctrl+Alt+B", None, self.toggle_context, "right sidebar walkthrough inspect run"),
            ("walkthrough", "Follow current instruction", "", None, lambda: self.show_context("walkthrough"), "activity tools progress output"),
            ("browse", "Browse project files", "", "files", lambda: self.show_context("inspect"), "folders tree right sidebar"),
            ("file", "Open file…", "Ctrl+P", "file-search-v1", self.files, "filename quick open code"),
            ("new", "New conversation", "Ctrl+N", "conversations", lambda: self.change_conversation("conversation.create", {}), "chat thread"),
            ("changes", "Review changes", "", "changes", self.changes, "git staged diff"),
            ("run", "Run app…", "", "project-run-v1", self.project, "preview command console stop app"),
            ("checkpoints", "Review checkpoints…", "", "checkpoints-v1", self.checkpoints, "restore safety versions"),
            ("context", "Inspect conversation context", "", "conversation-context-v1", lambda: self.evidence("Conversation context", "context.inspect", {"conversation": self.conversation}), "retained prompt"),
            ("history", "Read retained history", "", "context-history-v1", lambda: self.evidence("Retained history", "context.history", {"conversation": self.conversation}, True), "summaries messages"),
            ("memory", "Conversation memory…", "", "conversation-memory-v1", self.memory, "saved rules facts"),
            ("state", "Inspect saved state", "", "runtime-state-v1", lambda: self.evidence("Saved state", "state.inspect", {"conversation": self.conversation}), "recovery integrity interrupted"),
            ("check", "Check code…", "", "spider-check-v1", self.check_code, "syntax imports spider"),
            ("model", "Provider and model…", "", "model-selection-v1", self.models, "reasoning account key settings"),
            ("stop", "Stop all project work", "", "cancel", self.commands.stop, "cancel agent queue"),
            ("pods", "Show Pods overview", "", None, self.app.show_pods, "projects monitor workspaces"),
            ("projects", "Open project…", "Ctrl+O", None, lambda: self.app.choose_folder(self), "folder workspace"),
            ("sidebar", "Toggle conversations", "Ctrl+B", None, self.toggle_sidebar, "sidebar navigation"),
            ("composer", "Focus message", "Ctrl+L", None, self.composer.grab_focus, "draft send"),
        ]
        actions = []
        for identity, title, shortcut, capability, callback, keywords in specs:
            enabled = capability is None or ready and capability in self.client.capabilities
            if identity == "new":
                enabled = enabled and idle
            if identity == "stop":
                enabled = enabled and self.commands.can_stop()
            reason = ""
            if not enabled:
                reason = ("Reconnect this workspace to use this action" if not ready else
                          "Not supported by this runtime" if capability and capability not in self.client.capabilities else
                          "No project work is running" if identity == "stop" else
                          "Finish current work or review the pending instruction first")
            actions.append(dict(id=identity, title=title, shortcut=shortcut, callback=callback, keywords=keywords,
                                enabled=bool(enabled), reason=reason))
        return actions

    def show_tools(self):
        if self.palette and self.palette.valid_scope():
            self.palette.present()
            self.palette.query.grab_focus()
            return
        self.palette = CommandPalette(self)

    def check_code(self):
        panel = Panel(self, "Check code", 580, 340)
        panel.body.append(label("Inspect saved JavaScript or TypeScript files. This checks syntax and local imports; it does not run your project tests."))
        paths = Gtk.Entry(placeholder_text="Relative file paths, separated by commas")
        panel.body.append(paths)
        panel.body.append(button("Check files", lambda: self.evidence("Check code", "spider.check", {"paths": [value.strip() for value in paths.get_text().split(",") if value.strip()]})))
        panel.present()

    def files(self):
        if self.quick_open and self.quick_open.valid_scope():
            self.quick_open.present()
            self.quick_open.query.grab_focus()
            return
        self.quick_open = QuickOpen(self)

    def changes(self):
        self.show_context('changes')

    def models(self):
        panel = Panel(self, "Provider and model", 580, 460)
        provider = Gtk.ComboBoxText()
        model = Gtk.Entry(placeholder_text="Model ID", hexpand=True)
        reasoning = Gtk.ComboBoxText()
        panel.body.append(label("Provider"))
        panel.body.append(provider)
        panel.body.append(label("Model"))
        panel.body.append(model)
        panel.body.append(label("Reasoning (current model)"))
        panel.body.append(reasoning)
        catalog = {}
        def loaded(result):
            catalog.update(result)
            provider.remove_all()
            for item in result.get("providers", []):
                provider.append(item["id"], item["label"])
            provider.set_active_id(result.get("provider"))
            model.set_text(result.get("model", ""))
            reasoning.remove_all()
            reasoning.append("default", "Default")
            for effort in result.get("reasoningOptions", []):
                reasoning.append(effort, effort.capitalize())
            reasoning.set_active_id(result.get("reasoningEffort", "default"))
            if result.get("busy"):
                panel.show_error("Finish or stop current work before changing the model.")
        def apply():
            params = {"provider": provider.get_active_id(), "model": model.get_text(), "revision": catalog.get("revision", 0),
                      "reasoningEffort": reasoning.get_active_id() or "default"}
            panel.request("models.select", params, lambda _: (panel.destroy(), self.refresh()), panel.show_error)
        def available_models():
            picker = Panel(self, "Available models", 540, 540)
            selected_provider = provider.get_active_id()
            search = Gtk.SearchEntry(placeholder_text="Filter models…")
            picker.body.append(search)
            entries = Gtk.ListBox()
            entries.set_filter_func(lambda row: matches(search.get_text(), row.get_child().get_label()))
            search.connect("search-changed", lambda *_: entries.invalidate_filter())
            picker.body.append(scroll(entries))
            def found(result):
                if not panel.valid_scope() or provider.get_active_id() != selected_provider:
                    picker.invalidate("Provider changed. Reopen available models for the selected provider.")
                    return
                clear(entries)
                for item in result.get("models", []):
                    model_id = item if isinstance(item, str) else item.get("id", "")
                    if model_id:
                        entries.append(button(model_id, lambda value=model_id: (model.set_text(value), reasoning.set_active_id("default"), picker.destroy()) if panel.valid_scope() and provider.get_active_id() == selected_provider else picker.invalidate("Provider changed. Reopen this list.")))
                if not entries.get_first_child():
                    picker.show_error(result.get("message", "No models available. Enter a model ID manually or connect your provider."))
            picker.request("models.discover", {"provider": provider.get_active_id()}, found, picker.show_error)
            picker.present()
        panel.body.append(button("Available models…", available_models))
        panel.body.append(button("Apply model", apply, "suggested-action"))
        panel.body.append(button("Connect ChatGPT…", lambda: self.app.account(panel)))
        key = Gtk.PasswordEntry(show_peek_icon=True)
        key.set_tooltip_text("OpenRouter API key")
        panel.body.append(label("OpenRouter API key"))
        panel.body.append(key)
        def save_key():
            panel.request("openrouter.saveKey", {"apiKey": key.get_text()}, lambda _: (key.set_text(""), panel.show_error("OpenRouter key saved in LUMI.")), panel.show_error)
        key_button = button("Save key", save_key)
        key_button.set_sensitive("openrouter-credentials-v1" in self.client.capabilities)
        panel.body.append(key_button)
        panel.request("models.list", {}, loaded, panel.show_error)
        panel.present()

    def project(self):
        self.show_context('run')

    def checkpoints(self, selected=None):
        panel = Panel(self, "Checkpoints", 720, 620)
        items = Gtk.ListBox()
        panel.body.append(scroll(items))
        pager = box(False)
        panel.body.append(pager)
        def load(offset=0):
            def loaded(result):
                clear(items)
                clear(pager)
                panel.error.set_visible(False)
                for checkpoint in result.get("checkpoints", []):
                    row = box(margin=8)
                    row.append(label(checkpoint.get("label") or checkpoint.get("moment") or "Checkpoint", "heading"))
                    row.append(label(str(checkpoint.get("commit", "")), "dim-label"))
                    actions = box(False)
                    actions.append(button("Review restore…", lambda c=checkpoint: review(c)))
                    actions.append(button("Unflag" if checkpoint.get("flagged") else "Flag", lambda c=checkpoint: panel.request("checkpoint.flag", {"id": c["id"], "flagged": not c.get("flagged", False)}, lambda _: load(offset), panel.show_error)))
                    row.append(actions)
                    items.append(row)
                pager.append(button("Reload", lambda: load(offset)))
                if offset:
                    pager.append(button("Previous", lambda: load(max(0, offset - 100))))
                if result.get("more"):
                    pager.append(button("Next", lambda: load(offset + 100)))
            panel.request("checkpoint.list", {"offset": offset, **({"selected": selected} if selected and offset == 0 else {})}, loaded, panel.show_error)
        def review(checkpoint):
            def preview(result):
                self.confirm("Restore checkpoint?", "Review the file changes below. LUMI creates a safety copy and opens a new conversation; the original conversation is preserved.\n\n" + describe(result),
                             lambda: panel.request("checkpoint.restore", {"id": checkpoint["id"], "token": result["token"]},
                                              lambda _: (panel.destroy(), self.refresh()), panel.show_error), "Restore")
            panel.request("checkpoint.preview", {"id": checkpoint["id"]}, preview, panel.show_error)
        load()
        panel.present()

    def memory(self):
        panel = Panel(self, "Conversation memory", 680, 620)
        conversation = self.conversation
        query = Gtk.SearchEntry(placeholder_text="Search conversation memory")
        panel.body.append(query)
        items = Gtk.ListBox()
        panel.body.append(scroll(items))
        pager = box(False)
        panel.body.append(pager)
        def load(offset=0):
            def loaded(result):
                clear(items)
                clear(pager)
                for item in result.get("entries", []):
                    items.append(button(item["key"] + " — " + item.get("preview", ""), lambda entry=item: panel.request("memory.read", {"conversation": conversation, "id": entry["id"]}, edit, panel.show_error)))
                pager.append(button("New memory", lambda: edit({})))
                if offset:
                    pager.append(button("Previous", lambda: load(max(0, offset - 50))))
                if result.get("more"):
                    pager.append(button("Next", lambda: load(offset + 50)))
            panel.request("memory.list", {"conversation": conversation, "query": query.get_text(), "offset": offset}, loaded, panel.show_error)
        def edit(item):
            editor = Panel(self, "Edit memory" if item else "New memory")
            key = Gtk.Entry(text=item.get("key", ""), placeholder_text="Memory name")
            key.set_editable(not bool(item))
            editor.body.append(key)
            category = Gtk.ComboBoxText()
            for value in ("fact", "rule", "troubleshooting", "ki"):
                category.append(value, value.capitalize())
            category.set_active_id(item.get("category", "fact"))
            editor.body.append(category)
            content = text_view(True)
            content.get_buffer().set_text(item.get("value", ""))
            editor.body.append(scroll(content))
            def save():
                params = {"conversation": conversation, "key": key.get_text(), "value": text_value(content), "category": category.get_active_id()}
                if item:
                    params.update(id=item["id"], revision=item["revision"])
                editor.request("memory.write", params, lambda _: (editor.destroy(), load()), editor.show_error)
            editor.body.append(button("Save memory", save, "suggested-action"))
            if item:
                editor.body.append(button("Remove…", lambda: self.confirm("Remove memory?", item["key"],
                    lambda: editor.request("memory.remove", {"conversation": conversation, "id": item["id"], "revision": item["revision"]},
                                     lambda _: (editor.destroy(), load()), editor.show_error), "Remove")))
            editor.present()
        query.connect("activate", lambda *_: load())
        load()
        panel.present()

    def show_connection_details(self):
        panel = Panel(self, "Connection details", 720, 420, scoped=False)
        view = text_view()
        view.get_buffer().set_text(self.client.failure if self.client and self.client.failure else 'No startup details are available.')
        panel.body.append(scroll(view))
        panel.body.append(button('Close', panel.close))
        panel.present()

    def close_workspace(self, *_, force=False):
        if self.closed:
            return False
        if not (self.key in self.store.problems and not text_value(self.composer)) and not self.persist() and not force:
            return True
        self.closed = True
        self.task_context.dispose()
        for panel in list(self.panels):
            panel.destroy()
        if self.persist_source:
            GLib.source_remove(self.persist_source)
        if self.client:
            self.client.close()
            # Keep GTK alive while EOF cancels work and the worker releases its lock.
            self.app.hold()
            client = self.client
            def wait():
                client.process.wait()
                GLib.idle_add(self.app.release)
            threading.Thread(target=wait, daemon=True).start()
        self.app.workspaces.pop(self.folder, None)
        return False


class Application(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="io.heav3ns.Code", flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.store = StateStore()
        self.workspaces = {}
        self.library = None
        self.account_client = None
        self.pods_window = None

    def terminate(self):
        # Keep GTK alive through workspace holds until EOF cleanup releases the
        # engine's owner lock. SIGTERM must not bypass draft persistence.
        for workspace in list(self.workspaces.values()):
            workspace.close_workspace(force=True)
            workspace.destroy()
        if self.account_client:
            self.account_client.close()
        for window in self.get_windows():
            window.destroy()
        return False

    def review_state(self, parent, name, recovered):
        panel = Panel(parent, "Review saved desktop state", 720, 600, scoped=False)
        panel.body.append(label("The original saved desktop state could not be read. It may contain an instruction receipt. Inspect recorded instructions before sending the same work again. Archiving keeps the original file and resets only desktop drafts and receipts; agent history and project files are retained."))
        content = text_view(monospace=True)
        try:
            import os, stat
            descriptor = os.open(self.store.path(name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "r", errors="replace") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise OSError("Saved state is not a regular file")
                content.get_buffer().set_text(stream.read(65536) + "\n[Preview limited to 64 KiB]")
        except OSError as error:
            content.get_buffer().set_text(str(error))
        panel.body.append(scroll(content))
        def archive():
            try:
                backup = self.store.recover(name)
                recovered()
                panel.destroy()
                if hasattr(parent, "show_error"):
                    parent.show_error("Original desktop state preserved at " + str(backup))
            except (OSError, ValueError) as error:
                panel.show_error(error)
        panel.body.append(button("Archive original and reset desktop state", archive))
        panel.present()

    def show_pods(self):
        if self.pods_window:
            self.pods_window.present()
        else:
            self.pods_window = Pods(self)

    def do_startup(self):
        Gtk.Application.do_startup(self)
        css = Gtk.CssProvider()
        css.load_from_data(b".user-message { background-color: alpha(@theme_selected_bg_color, 0.12); border-radius: 10px; padding: 12px; } .error { color: @error_color; }")
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def do_activate(self):
        self.show_library()

    def do_open(self, files, count, hint):
        for file in files:
            if file.get_path():
                self.open_workspace(file.get_path())

    def show_library(self):
        if self.library:
            self.library.present()
            return
        window = Gtk.ApplicationWindow(application=self, title="HEAV3NS-CODE", default_width=800, default_height=620)
        self.library = window
        window.connect("close-request", lambda *_: setattr(self, "library", None) or False)
        body = box(margin=28, spacing=16)
        body.append(label("Your projects", "title-1"))
        body.append(label("Build with LUMI. Open a project to start a conversation.", "dim-label"))
        actions = box(False)
        actions.append(button("Open project…", lambda: self.choose_folder(window), "suggested-action"))
        actions.append(button("Pods", self.show_pods))
        actions.append(button("New project…", lambda: self.new_project(window)))
        actions.append(button("Connect ChatGPT…", lambda: self.account(window)))
        body.append(actions)
        self.library_error = label("", "error")
        body.append(self.library_error)
        recovery = button("Review saved project library…", lambda: self.review_state(window, "projects", lambda: (populate(), recovery.set_visible(False))))
        recovery.set_visible(False)
        body.append(recovery)
        query = Gtk.SearchEntry(placeholder_text="Find a recent project")
        body.append(query)
        listing = Gtk.ListBox()
        body.append(scroll(listing))
        def populate(*_):
            clear(listing)
            projects = self.store.read("projects", [])
            recovery.set_visible("projects" in self.store.problems)
            for entry in sorted(projects, key=lambda p: (not p.get("pinned", False), -p.get("opened", 0))):
                folder = entry["path"]
                if not matches(query.get_text(), folder):
                    continue
                row = box(False, margin=8)
                item = button("", lambda f=folder: self.open_workspace(f))
                item.set_tooltip_text(folder)
                text = box(spacing=4)
                title = label(Path(folder).name, "heading")
                path = label(folder, "dim-label")
                for value in (title, path):
                    value.set_wrap(False)
                    value.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
                    value.set_selectable(False)
                    text.append(value)
                available = Path(folder).is_dir()
                if not available:
                    text.append(label("Folder unavailable · Choose Locate to find it", "dim-label"))
                item.set_sensitive(available)
                item.set_child(text)
                item.set_hexpand(True)
                row.append(item)
                def pin(path=folder):
                    projects = self.store.read("projects", [])
                    for project in projects:
                        if project["path"] == path:
                            project["pinned"] = not project.get("pinned", False)
                    try:
                        self.store.write("projects", projects)
                        populate()
                    except OSError as error:
                        self.library_error.set_text(str(error))
                row.append(button("Unpin" if entry.get("pinned") else "Pin", pin))
                def remove(path=folder):
                    try:
                        self.store.write("projects", [p for p in self.store.read("projects", []) if p["path"] != path])
                        populate()
                    except OSError as error:
                        self.library_error.set_text(str(error))
                if not available:
                    def locate(old=folder):
                        def selected(path):
                            try:
                                entries = self.store.read("projects", [])
                                previous = next((p for p in entries if p["path"] == old), {"path": path})
                                previous["path"] = path
                                self.store.write("projects", [previous] + [p for p in entries if p["path"] not in (path, old)])
                                self.open_workspace(path)
                                populate()
                            except OSError as error:
                                self.library_error.set_text(str(error))
                        self.choose_folder(window, selected)
                    row.append(button("Locate…", locate))
                remove_button = button("Remove", remove)
                remove_button.set_tooltip_text("Remove from recent projects. Project files are kept.")
                row.append(remove_button)
                listing.append(row)
        self.populate_library = populate
        query.connect("search-changed", populate)
        populate()
        window.set_child(body)
        window.present()

    def choose_folder(self, parent, selected=None, multiple=False, finished=None):
        chooser = Gtk.FileChooserNative(title="Load projects" if multiple else "Open project", transient_for=parent,
                                        action=Gtk.FileChooserAction.SELECT_FOLDER, accept_label="Open", cancel_label="Cancel")
        chooser.set_select_multiple(multiple)
        def response(dialog, result):
            try:
                if result == Gtk.ResponseType.ACCEPT:
                    files = dialog.get_files()
                    paths = [files.get_item(i).get_path() for i in range(files.get_n_items())]
                    paths = [path for path in paths if path]
                    if multiple:
                        (selected or (lambda values: [self.open_workspace(path) for path in values]))(paths)
                    elif paths:
                        (selected or self.open_workspace)(paths[0])
            finally:
                dialog.destroy()
                if finished:
                    finished()
        chooser.connect("response", response)
        chooser.show()
        return chooser

    def new_project(self, parent):
        panel = Panel(parent, "New project", 480, 240)
        name = Gtk.Entry(placeholder_text="Project name")
        panel.body.append(name)
        location = label(str(Path.home()))
        panel.body.append(location)
        panel.body.append(button("Choose location…", lambda: self.choose_folder(panel, location.set_text)))
        def create():
            title = name.get_text().strip()
            if not title or title in (".", "..") or "/" in title or "\x00" in title:
                panel.show_error("Choose a project name without path separators.")
                return
            folder = Path(location.get_text()) / title
            try:
                folder.mkdir()
                self.open_workspace(str(folder))
                panel.destroy()
            except OSError as error:
                panel.show_error(error)
        panel.body.append(button("Create project", create, "suggested-action"))
        panel.present()

    def open_workspace(self, folder, on_error=None):
        def failed(message):
            if on_error:
                on_error(message)
            else:
                self.show_library()
                self.library_error.set_text(message)
        try:
            folder = str(Path(folder).resolve())
            exists = Path(folder).is_dir()
        except (OSError, RuntimeError) as error:
            failed('Could not open this project: ' + str(error))
            return
        if folder in self.workspaces:
            self.workspaces[folder].present()
            return self.workspaces[folder]
        if not exists:
            failed('Project folder is unavailable: ' + folder)
            return
        if len(self.workspaces) >= 4:
            failed('Four projects are already open. Close a workspace before loading ' + Path(folder).name + '.')
            return
        self.workspaces[folder] = Workspace(self, folder)
        projects = self.store.read("projects", [])
        existing = next((p for p in projects if p["path"] == folder), {"path": folder})
        existing["opened"] = time.time()
        try:
            self.store.write("projects", [existing] + [p for p in projects if p["path"] != folder][:99])
        except OSError as error:
            self.workspaces[folder].show_error("Could not update recent projects: " + str(error))
        if self.library:
            self.populate_library()
        return self.workspaces[folder]

    def account(self, parent):
        if self.account_client and not self.account_client.closed:
            return
        panel = Panel(parent, "Connect ChatGPT", 540, 320)
        message = label("Use your browser to connect. Credentials are stored by LUMI and never enter this interface.")
        panel.body.append(message)
        try:
            client = RuntimeClient(Path.home(), account=True)
        except Exception as error:
            panel.show_error(error)
            panel.present()
            return
        self.account_client = client
        pending_methods = set()
        def request(method):
            if not panel.alive or not panel.get_visible() or client.closed or method in pending_methods:
                return
            pending_methods.add(method)
            future = client.request(method)
            def done():
                pending_methods.discard(method)
                if not panel.alive or not panel.get_visible() or self.account_client is not client:
                    return False
                try:
                    value = future.result()
                    message.set_text("Connected. Reopen your project to use newly saved credentials." if value.get("saved") else "Not connected.")
                except Exception as error:
                    panel.show_error(error)
                return False
            future.add_done_callback(lambda _: GLib.idle_add(done))
        panel.body.append(button("Sign in with browser", lambda: request("signIn"), "suggested-action"))
        panel.body.append(button("Cancel sign-in", lambda: request("cancel")))
        panel.body.append(button("Sign out", lambda: request("signOut")))
        panel.connect("close-request", lambda *_: client.close() or False)
        def poll():
            if not panel.alive or not panel.get_visible():
                client.close()
                return False
            try:
                while True:
                    event = client.events.get_nowait()
                    url = event.get("url", "")
                    if authorization_url(url):
                        Gio.AppInfo.launch_default_for_uri(url, None)
                    else:
                        client.fail("Unsupported sign-in address.")
                        panel.show_error(client.failure)
            except queue.Empty:
                pass
            return not client.closed
        panel.present()
        request("status")
        GLib.timeout_add(100, poll)


def main():
    app = Application()
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, app.terminate)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, app.terminate)
    return app.run(sys.argv)
