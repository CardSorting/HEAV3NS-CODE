"""A stable review surface shared by the conversation and Pods."""
from gi.repository import Gtk, Pango
from .widgets import box, button, label, scroll, text_view
from .workspace_commands import approval_identity, current_approval, ready


class ApprovalView:
    def __init__(self, owner):
        self.owner, self.displayed = owner, None
        self.view = box(spacing=6)
        self.heading = label('Approval required', 'heading')
        self.heading.set_wrap(False)
        self.heading.set_ellipsize(Pango.EllipsizeMode.END)
        self.heading.set_max_width_chars(1)
        self.view.append(self.heading)
        self.details = text_view(monospace=True)
        self.details.update_property([Gtk.AccessibleProperty.LABEL], ['Full approval arguments, reason and workspace'])
        self.pane = scroll(self.details, False)
        self.pane.set_min_content_height(88)
        self.pane.set_max_content_height(88)
        self.pane.add_css_class('frame')
        self.view.append(self.pane)
        self.message = label('', 'dim-label')
        self.message.set_lines(2)
        self.message.set_ellipsize(Pango.EllipsizeMode.END)
        self.message.set_max_width_chars(1)
        self.view.append(self.message)
        self.actions = box(False, spacing=6)
        self.next = button('Review next request', self.review_next)
        self.deny = button('Deny', lambda: self.decide('deny'))
        self.allow = button('Allow once', lambda: self.decide('allow'), 'suggested-action')
        for control in (self.next, self.deny, self.allow):
            self.actions.append(control)
        self.view.append(self.actions)
        self.view.set_visible(False)

    def review_next(self):
        self.displayed = None
        self.update()
        self.deny.grab_focus()

    def decide(self, decision):
        self.owner.commands.decide(self.displayed, decision)
        self.update()

    def update(self):
        owner = self.owner
        owner.commands.sync()
        key = approval_identity(owner)
        self.view.set_visible(bool(key))
        if not key:
            self.displayed = None
            return
        if self.displayed is None:
            self.displayed = key
            approval = current_approval(owner)['approval']
            title = 'Approval required · ' + approval.get('tool', 'Operation')
            self.heading.set_text(title)
            self.heading.set_tooltip_text(title)
            self.details.get_buffer().set_text(
                'Arguments\n' + (approval.get('args') or 'No arguments supplied.') +
                '\n\nReason\n' + (approval.get('reason') or 'Review this operation before it runs.') +
                '\n\nWorkspace\n' + approval.get('scope', owner.folder))
            self.pane.get_vadjustment().set_value(0)
        same = self.displayed == key
        enabled = owner.commands.can_decide(self.displayed)
        self.deny.set_sensitive(enabled)
        self.allow.set_sensitive(enabled)
        self.deny.set_visible(same)
        self.allow.set_visible(same)
        self.next.set_visible(not same)
        message = ('A new request is waiting. Review it before deciding.' if not same else
                   owner.commands.approval_error or
                   ('Disconnected. Reconnect to recover the recorded decision.' if not ready(owner) else
                    'Stopping project work…' if owner.commands.stop_pending else
                    'Saving decision…' if owner.commands.approval_pending else
                    'Approvals unavailable in this runtime.' if 'approval' not in owner.client.capabilities else
                    'Allow once applies only to this operation.'))
        if self.message.get_text() != message:
            self.message.set_text(message)
            self.message.set_tooltip_text(message)
