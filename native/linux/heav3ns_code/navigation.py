"""Bounded presentation models shared by keyboard and pointer navigation."""
from dataclasses import dataclass
from pathlib import PurePosixPath
import re
import unicodedata


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', str(value)).casefold() if not unicodedata.combining(c))


def matches(query, *values):
    haystack = normalized(' '.join(str(value) for value in values))
    return all(word in haystack for word in normalized(query).split())


@dataclass(frozen=True)
class Destination:
    title: str
    method: str
    params: tuple = ()
    paged: bool = False

    @classmethod
    def create(cls, title, method, params=None, paged=False):
        # Only navigation values; never store file contents or entire runtime responses.
        import json
        return cls(title, method, tuple((key, json.dumps(value, sort_keys=True)) for key, value in sorted((params or {}).items())), paged)

    def arguments(self):
        import json
        return {key: json.loads(value) for key, value in self.params}


class History:
    def __init__(self, limit=64):
        self.limit, self.entries, self.index = limit, [], -1

    @property
    def current(self):
        return self.entries[self.index] if self.index >= 0 else None

    @property
    def can_back(self):
        return self.index > 0

    @property
    def can_forward(self):
        return self.index + 1 < len(self.entries)

    def visit(self, destination):
        if self.current == destination:
            return
        self.entries = (self.entries[:self.index + 1] + [destination])[-self.limit:]
        self.index = len(self.entries) - 1

    def move(self, direction):
        if (direction < 0 and self.can_back) or (direction > 0 and self.can_forward):
            self.index += direction
        return self.current


class RequestGate:
    """Invalidate late replies on a new query, close, navigation, or reconnect."""
    def __init__(self):
        self.generation = 0
        self.serials = {}

    def issue(self, lane='read'):
        self.serials[lane] = self.serials.get(lane, 0) + 1
        return self.generation, lane, self.serials[lane]

    def accepts(self, ticket):
        generation, lane, serial = ticket
        return generation == self.generation and self.serials.get(lane) == serial

    def invalidate(self):
        self.generation += 1
        self.serials.clear()


def outline(text, path):
    patterns = {
        '.py': r'^\s*(?:async\s+)?(?:class|def)\s+(\w+)',
        '.swift': r'^\s*(?:(?:public|private|internal|final|static|override|open)\s+)*(?:struct|class|enum|protocol|extension|actor|func)\s+([\w.]+)',
        '.ts': r'^\s*(?:(?:export|default|declare|abstract|async)\s+)*(?:class|interface|type|enum|function|const|let)\s+([\w$]+)',
        '.rs': r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:struct|enum|trait|impl|fn)\s+(\w+)',
        '.go': r'^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)(\w+)',
    }
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in ('.tsx', '.js', '.jsx', '.mjs', '.cjs'):
        suffix = '.ts'
    pattern = patterns.get(suffix)
    if not pattern:
        return []
    entries = []
    for number, line in enumerate(text.splitlines()[:10000]):
        match = re.match(pattern, line)
        if match:
            entries.append((number, match.group(1), line.strip()[:160]))
        if len(entries) >= 100:
            break
    return entries


def safe_file(value):
    return (isinstance(value, str) and bool(value) and '\x00' not in value and '\\' not in value
            and not PurePosixPath(value).is_absolute() and '..' not in PurePosixPath(value).parts)


def elapsed(run, now):
    start = run.get('startedAt')
    if not isinstance(start, (int, float)) or start <= 0:
        return 'Not started' if run.get('state') == 'queued' else 'Timing unavailable'
    end = now * 1000 if run.get('state') in ('running', 'awaiting_approval', 'cancelling') else run.get('updatedAt', start)
    seconds = max(0, int((end - start) / 1000))
    minutes, seconds = divmod(seconds, 60)
    return f'{minutes}:{seconds:02d}' if minutes < 60 else f'{minutes // 60}:{minutes % 60:02d}:{seconds:02d}'
