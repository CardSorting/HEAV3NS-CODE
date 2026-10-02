"""Private XDG presentation state; credentials remain in the shared runtime."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import re
import math
import uuid
from urllib.parse import urlsplit


def authorization_url(value):
    try:
        url = urlsplit(value)
        return (url.scheme == "https" and url.hostname == "auth.openai.com"
                and url.port in (None, 443) and not url.username and not url.password
                and url.path in ("/oauth/authorize", "/api/accounts/authorize"))
    except ValueError:
        return False


def preview_url(value):
    try:
        url = urlsplit(value)
        return (url.scheme in ("http", "https") and url.hostname in ("localhost", "127.0.0.1", "::1")
                and not url.username and not url.password)
    except ValueError:
        return False


class StateStore:
    def __init__(self, root=None):
        xdg = os.environ.get("XDG_STATE_HOME", "")
        self.root = Path(root) if root else (Path(xdg) if os.path.isabs(xdg) else Path.home() / ".local/state") / "heav3ns-code"
        self.problems = {}
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", name):
            raise ValueError("Invalid desktop state name")
        return self.root / (name + ".json")

    def read(self, name, default=None):
        file = self.path(name)
        try:
            descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "r") as stream:
                import stat
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Desktop state must be a regular file")
                raw = stream.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Desktop state exceeds 8 MiB")
            value = json.loads(raw)
            validate_state(name, value)
            self.problems.pop(name, None)
            return value
        except FileNotFoundError:
            return default
        except (OSError, ValueError, TypeError, RecursionError) as error:
            self.problems[name] = str(error)
            return default

    def write(self, name, value):
        file = self.path(name)
        if name in self.problems:
            raise OSError("Saved desktop state needs review before it can be replaced. The original file is preserved.")
        try:
            validate_state(name, value)
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            raise OSError("Desktop state could not be saved: " + str(error)) from error
        if len(encoded) > 8 * 1024 * 1024:
            raise OSError("Desktop drafts exceed 8 MiB. Shorten or clear old drafts before saving.")
        descriptor, temporary = tempfile.mkstemp(dir=self.root)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, file)
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def recover(self, name):
        """Explicit user recovery archives the unreadable file before any replacement."""
        file = self.path(name)
        backup = self.root / (name + ".recovery-" + uuid.uuid4().hex + ".json")
        if file.exists() or file.is_symlink():
            file.rename(backup)
        self.problems.pop(name, None)
        return backup

    @staticmethod
    def workspace_key(folder):
        return hashlib.sha256(str(Path(folder).resolve()).encode()).hexdigest()


def validate_state(name, value):
    def text(item, limit=1000000):
        return isinstance(item, str) and len(item) <= limit and not any(0xD800 <= ord(c) <= 0xDFFF for c in item)
    if name == "projects":
        if not isinstance(value, list) or len(value) > 100:
            raise ValueError("Invalid project library")
        for item in value:
            if (not isinstance(item, dict) or not text(item.get("path"), 4096)
                    or not os.path.isabs(item["path"]) or type(item.get("opened", 0)) not in (int, float)
                    or not math.isfinite(item.get("opened", 0))):
                raise ValueError("Invalid saved project")
    else:
        if not isinstance(value, dict):
            raise ValueError("Invalid workspace desktop state")
        layout = value.get('layout', {})
        if (not isinstance(layout, dict)
                or any(key in layout and type(layout[key]) is not bool for key in ('sidebar', 'context'))
                or ('width' in layout and (type(layout['width']) is not int or not 370 <= layout['width'] <= 720))
                or layout.get('tab', 'walkthrough') not in ('walkthrough', 'changes', 'inspect', 'run')):
            raise ValueError('Invalid workspace layout preferences')
        drafts, continuations = value.get("drafts", {}), value.get("continuations", {})
        if not isinstance(drafts, dict) or not isinstance(continuations, dict):
            raise ValueError("Invalid saved drafts")
        if any(not text(key, 128) or not text(draft) for key, draft in drafts.items()):
            raise ValueError("Invalid saved draft text")
        for item in continuations.values():
            if item is not None and (not isinstance(item, dict) or not text(item.get("run"), 128) or type(item.get("revision")) is not int):
                raise ValueError("Invalid continuation receipt")
        pending = value.get("pending")
        if pending is not None and (not isinstance(pending, dict) or any(not text(pending.get(key), 128 if key != "text" else 1000000) or not pending[key] for key in ("id", "session", "conversation", "text"))):
            raise ValueError("Invalid submission receipt. Review recorded instructions before sending more work.")
