"""Shared GTK controls and scoped modeless panel lifecycle."""
import json
import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk, Pango
from .navigation import RequestGate
from .transport import READ_METHODS

def box(vertical=True, spacing=10, margin=0):
    widget = Gtk.Box(orientation=Gtk.Orientation.VERTICAL if vertical else Gtk.Orientation.HORIZONTAL, spacing=spacing)
    for side in ("top", "bottom", "start", "end"):
        getattr(widget, "set_margin_" + side)(margin)
    return widget


def label(text, style=None):
    widget = Gtk.Label(label=str(text), xalign=0, wrap=True, selectable=True)
    widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
    if style:
        widget.add_css_class(style)
    return widget


def button(text, action, style=None):
    widget = Gtk.Button(label=text)
    widget.connect("clicked", lambda *_: action())
    if style:
        widget.add_css_class(style)
    return widget


def scroll(child, expand=True):
    widget = Gtk.ScrolledWindow(hexpand=True, vexpand=expand)
    widget.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    widget.set_child(child)
    return widget


def clear(widget):
    while widget.get_first_child():
        widget.remove(widget.get_first_child())


def text_value(view):
    buffer = view.get_buffer()
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)


def text_view(editable=False, monospace=False):
    return Gtk.TextView(editable=editable, cursor_visible=editable, monospace=monospace,
                        wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=12, bottom_margin=12,
                        left_margin=12, right_margin=12)


def describe(value):
    """Readable, complete runtime evidence, with keys retained for precision."""
    if isinstance(value, str):
        return value
    return json.dumps(value, indent=2, ensure_ascii=False)


class ScopedSurface:
    """The same request lifetime for embedded views and auxiliary windows."""
    def init_scope(self, owner, scoped=True, register=False):
        self.owner = owner
        self.client = owner.client if owner else None
        self.conversation = owner.conversation if owner else None
        self.scoped, self.alive, self.invalidated = scoped, True, False
        self.gate, self.busy, self.timers = RequestGate(), set(), set()
        if register and owner and hasattr(owner, 'panels'):
            owner.panels.add(self)

    def dispose_callbacks(self):
        self.alive = False
        self.gate.invalidate()
        for timer in self.timers:
            GLib.source_remove(timer)
        self.timers.clear()
        if self.owner and hasattr(self.owner, "panels"):
            self.owner.panels.discard(self)

    def valid_scope(self):
        return (self.alive and not self.invalidated and (not self.owner or
                (not self.owner.closed and self.client is self.owner.client and
                 (not self.scoped or self.conversation == self.owner.conversation))))

    def invalidate(self, message="Conversation or connection changed. Reopen this tool from the current workspace."):
        if not self.alive:
            return
        self.invalidated = True
        self.gate.invalidate()
        self.body.set_sensitive(False)
        self.show_error(message)

    def show_error(self, error):
        if self.alive:
            self.error.set_text(str(error))
            self.error.set_visible(True)

    def request(self, method, params=None, callback=None, error=None, lane=None, mutation=None):
        if not self.valid_scope():
            self.invalidate()
            return
        lane = lane or method
        if mutation is None:
            mutation = method not in READ_METHODS
        if lane in self.busy:
            return
        ticket = self.gate.issue(lane)
        if mutation:
            self.busy.add(lane)
        def delivered(value, failed=False):
            self.busy.discard(lane)
            if not self.valid_scope() or not self.gate.accepts(ticket):
                return
            if failed:
                (error or self.show_error)(value)
            else:
                self.error.set_visible(False)
                if callback:
                    callback(value)
        self.owner.rpc(method, params, lambda result: delivered(result), lambda reason: delivered(reason, True))

    def every(self, milliseconds, callback):
        timer = None
        def tick():
            if not self.valid_scope():
                self.timers.discard(timer)
                return False
            if self.get_mapped():
                callback()
            return True
        timer = GLib.timeout_add(milliseconds, tick)
        self.timers.add(timer)
        return timer


class Panel(Gtk.Window, ScopedSurface):
    def __init__(self, parent, title, width=680, height=540, scoped=True):
        Gtk.Window.__init__(self, title=title, transient_for=parent, default_width=width, default_height=height)
        self.set_destroy_with_parent(True)
        self.init_scope(parent if hasattr(parent, 'rpc') else None, scoped, register=True)
        root = box(margin=18)
        self.set_child(root)
        self.error = label('', 'error')
        self.error.set_visible(False)
        root.append(self.error)
        self.body = box()
        self.body.set_vexpand(True)
        root.append(self.body)
        self.connect('close-request', self._closing)
        keys = Gtk.EventControllerKey()
        keys.connect('key-pressed', self._keys)
        self.add_controller(keys)

    def _keys(self, controller, key, code, state):
        if key == Gdk.KEY_Escape and not state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK):
            self.close()
            return True
        return False

    def _closing(self, *_):
        self.dispose_callbacks()
        return False

    def destroy(self):
        self.dispose_callbacks()
        Gtk.Window.destroy(self)


class EmbeddedPanel(Gtk.Box, ScopedSurface):
    def __init__(self, owner, title=''):
        Gtk.Box.__init__(self, orientation=Gtk.Orientation.VERTICAL, spacing=8, hexpand=True, vexpand=True)
        self.init_scope(owner)
        self.title = title
        self.error = label('', 'error')
        self.error.set_visible(False)
        self.append(self.error)
        self.body = box()
        self.body.set_vexpand(True)
        self.append(self.body)

    def set_title(self, title):
        self.title = title

    def get_title(self):
        return self.title

    def present(self):
        self.set_visible(True)

    def destroy(self):
        self.dispose_callbacks()



def icon_button(icon, title, action):
    widget = Gtk.Button(icon_name=icon)
    widget.set_tooltip_text(title)
    widget.update_property([Gtk.AccessibleProperty.LABEL], [title])
    widget.connect("clicked", lambda *_: action())
    return widget
