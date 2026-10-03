"""Bounded, read-only projections of each workspace's authoritative snapshot."""
import math
from .navigation import matches
from .workspace_commands import current_approval, ready

MAX_FEED = 24_000
LIVE_STATES = {'running', 'awaiting_approval', 'cancelling'}


def number(value, default=0):
    return value if type(value) in (int, float) and math.isfinite(value) else default


def duration(seconds):
    value = int(min(max(number(seconds), 0), 31_536_000))
    if value < 60:
        return f'{value}s'
    if value < 3600:
        return f'{value // 60}m {value % 60}s'
    if value < 86400:
        return f'{value // 3600}h {value % 3600 // 60}m'
    return f'{value // 86400}d {value % 86400 // 3600}h'


def current_run(owner):
    return owner.runs.get(getattr(owner, 'active', None)) or max(
        owner.runs.values(), key=lambda item: (number(item.get('createdAt')), item['id']), default={})


def stream_text(run):
    activities = sorted(run.get('activities', []), key=lambda item: number(item.get('startedSequence', item.get('sequence'))))
    entries, shortened = [], False
    for item in activities[-30:]:
        title = item.get('message', 'Activity') + ' · ' + str(item.get('status', '')).replace('_', ' ')
        files = ', '.join(item.get('metadata', {}).get('files', []))
        entry = '\n'.join(value for value in (title, item.get('detail', ''), files) if value)
        shortened |= len(entry) > 1800
        entries.append(entry[:1800])
    response = run.get('response', '')
    shortened |= len(response) > 6000
    final = 'LUMI\n' + response[:6000] if response else ''
    while entries and len('\n\n'.join(entries)) + len(final) > MAX_FEED - 400:
        entries.pop(0)
    shown = len(entries)
    total = max(number(run.get('activityCount')), len(activities))
    if total > shown:
        entries.insert(0, f'Showing {shown} of {total} observed activities. Open Conversation → Walkthrough for retained history.')
    if shortened:
        entries.insert(0, 'Preview shortened. Open Conversation → Walkthrough for retained detail.')
    if final:
        entries.append(final)
    return '\n\n'.join(entries)


def snapshot(owner, now):
    owner.commands.sync()
    run = current_run(owner)
    connected = ready(owner)
    review = current_approval(owner) is not None
    queued = len(getattr(owner, 'queued', []))
    running = connected and bool(getattr(owner, 'active', None) or queued) and not review
    status = {'failed': 'Failed', 'interrupted': 'Interrupted', 'completed': 'Completed',
              'cancelled': 'Stopped', 'queued': 'Queued', 'cancelling': 'Stopping'}.get(run.get('state'), 'Ready')
    if owner.switching:
        status = 'Opening conversation'
    elif not connected:
        status = 'Connecting' if owner.client and not owner.client.closed else 'Disconnected'
    elif owner.commands.stop_pending:
        status = 'Stopping'
    elif getattr(owner, 'pending_submission', None) and not getattr(owner, 'submitting', False):
        status = 'Check connection'
    elif owner.commands.approval_pending:
        status = 'Saving decision'
    elif review:
        status = 'Needs review'
    elif getattr(owner, 'submitting', False):
        status = 'Submitting'
    elif running:
        status = 'Working'
    activities = run.get('activities', [])
    start = number(run.get('startedAt'))
    last = max([number(item.get('timestamp')) for item in activities] + [start])
    parts = []
    if start > 0:
        live = run.get('state') in LIVE_STATES
        end = now if live else number(run.get('updatedAt'), start)
        parts.append(('Elapsed ' if live else 'Duration ') + duration((end - start) / 1000))
    requested = number(run.get('approval', {}).get('createdAt')) if review else 0
    if requested:
        parts.append(f'Waiting {duration((now - requested) / 1000)} for you')
    elif running and last:
        parts.append(f'Last activity {duration((now - last) / 1000)} ago')
    count = max(number(run.get('activityCount')), len(activities))
    if count:
        parts.append(f'{count} activities')
    note = ''
    if not connected:
        note = ('Connecting to this project’s agent…' if status == 'Connecting' else
                'Opening the selected conversation…' if owner.switching else
                'Disconnected · last confirmed state. Reconnect to recover; work is not restarted automatically.')
    elif running and last and now - last >= 120_000:
        note = f'No activity for {duration((now - last) / 1000)}. The agent is connected; this does not confirm it is stalled.'
    return dict(path=owner.folder, thread=owner.title.get_text(), run=run, status=status,
                instruction=run.get('text', ''), running=running, review=review, queued=queued,
                attention=review or status in {'Disconnected', 'Check connection', 'Failed', 'Interrupted'},
                timing=' · '.join(parts) or ('No task started' if not run else 'Timing unavailable for this run'),
                note=owner.commands.stop_error or note,
                identity=(id(owner.client), owner.conversation, run.get('id')))


def includes(value, mode, query):
    return ((mode == 'all' or mode == 'working' and (value['running'] or value['queued'])
             or mode == 'attention' and value['attention']) and
            matches(query, value['path'], value['thread'], value['instruction']))


class FeedState:
    def __init__(self):
        self.identity = None
        self.displayed = self.latest = ''
        self.paused = False

    def update(self, text, identity, reading=False):
        if identity != self.identity:
            self.identity, self.paused = identity, False
            self.displayed = text
        elif reading:
            self.paused = True
        self.latest = text
        if not self.paused:
            self.displayed = text

    def resume(self):
        self.paused, self.displayed = False, self.latest
