"""Private, bounded JSON-lines transport. No GTK dependency or execution logic."""
import json
import itertools
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import Future

MAX_FRAME = 256 * 1024
READ_METHODS = {"models.list", "models.discover", "openrouter.status", "files.list", "files.search", "files.read",
                "changes.list", "changes.read", "artifact.read", "history.list", "history.read", "activity.list",
                "conversation.list", "memory.list", "memory.read", "context.inspect", "context.history", "state.inspect",
                "spider.check", "checkpoint.list", "checkpoint.preview", "project.discover", "project.status", "task.lookup"}
CONTROLS = {"snapshot", "task.cancel", "task.cancelAll", "approval.resolve",
            "project.stop", "project.healing", "shutdown"}


class ProtocolError(Exception):
    pass


class RuntimeRejected(ProtocolError):
    """An explicit negative acknowledgement, with no acceptance ambiguity."""


class FrameDecoder:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data):
        frames = []
        parts = data.split(b"\n")
        for index, part in enumerate(parts):
            if len(self.pending) + len(part) > MAX_FRAME:
                raise ProtocolError("Runtime frame exceeds 256 KiB.")
            self.pending.extend(part)
            if index < len(parts) - 1:
                if self.pending:
                    value = json.loads(self.pending.decode("utf-8"))
                    if not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] != 1:
                        raise ProtocolError("Incompatible runtime protocol. Rebuild app and runtime together.")
                    frames.append(value)
                self.pending.clear()
        return frames

    def finish(self):
        if self.pending:
            raise ProtocolError("Runtime disconnected mid-frame. Last outcome may be unknown.")


def runtime_paths():
    root = Path(__file__).resolve().parents[1]
    bundled = root / "runtime"
    node = os.environ.get("HEAV3NS_NODE") or str(bundled / "node")
    cli = os.environ.get("HEAV3NS_CLI") or str(bundled / "dist/index.js")
    if not bundled.exists():
        node = os.environ.get("HEAV3NS_NODE") or shutil.which("node") or ""
        cli = os.environ.get("HEAV3NS_CLI") or str(root.parents[1] / "dist/index.js")
    if not node or not os.access(node, os.X_OK) or not Path(cli).is_file():
        raise ProtocolError("LUMI runtime is missing. Run npm run desktop:build or npm run build for development.")
    return node, cli


def valid_result(method, result):
    def run(value):
        return (isinstance(value, dict) and isinstance(value.get("id"), str)
                and isinstance(value.get("text"), str)
                and value.get("state") in {"queued", "running", "awaiting_approval", "cancelling",
                                           "completed", "failed", "cancelled", "interrupted"})
    if method in ("snapshot", "workspace.attach"):
        return isinstance(result.get("runs"), list) and all(run(value) for value in result["runs"])
    if method == "task.submit":
        return result.get("accepted") is True and run(result.get("run"))
    if method == "task.lookup":
        return type(result.get("found")) is bool and (not result["found"] or run(result.get("run")))
    if method == "approval.resolve":
        return result.get("resolved") is True
    return True


class RuntimeClient:
    def __init__(self, folder, command=None, account=False, timeout=20):
        self.folder = str(Path(folder).resolve())
        self.account = account
        self.timeout = timeout
        self.workspace = self.session = self.runtime = ""
        self.capabilities = set()
        self.instruction_limit = 16000
        self.queue_limit = 3
        self.ready = False
        self.closed = False
        self.pending = {}
        self.lock = threading.RLock()
        # At most 4 MiB of maximum-sized frames await UI delivery/writing.
        self.events = queue.Queue(maxsize=16)
        self.writes = queue.PriorityQueue(maxsize=16)
        self.write_order = itertools.count()
        self.failure = None
        self.diagnostics = bytearray()
        self.diagnostics_done = threading.Event()
        if command is None:
            node, cli = runtime_paths()
            command = [node, cli, "--desktop-account" if account else "--desktop-worker"]
        self.process = subprocess.Popen(command, cwd=self.folder,
                                        env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, bufsize=0)
        for target in (self._diagnostics, self._read, self._write, self._watch):
            threading.Thread(target=target, daemon=True).start()

    def _diagnostics(self):
        try:
            while True:
                data = self.process.stderr.read(4096)
                if not data:
                    break
                # Drain continuously so stderr cannot deadlock startup. Retain
                # only a bounded, in-memory tail; never write an account log.
                with self.lock:
                    self.diagnostics.extend(data)
                    del self.diagnostics[:-16384]
        except (OSError, ValueError):
            pass
        finally:
            self.process.stderr.close()
            self.diagnostics_done.set()

    def startup_failure(self):
        self.diagnostics_done.wait(.25)
        with self.lock:
            details = self.diagnostics.decode('utf-8', errors='replace').strip()
        if 'WORKSPACE_OWNED:' in details:
            summary = 'This project has another recorded owner. Close its other session, then reconnect.'
        else:
            summary = 'LUMI could not start. Review the connection details, then reconnect.'
        return summary + ('\n\n' + details[-8000:] if details else '')

    def connect(self):
        hello = self.request("hello").result(self.timeout + 1)
        if hello.get("protocol") != 1 or any(not isinstance(hello.get(k), str) or not hello[k]
                                               for k in ("workspace", "session", "runtime")):
            self.fail("Incompatible runtime identity.")
            raise ProtocolError(self.failure)
        self.workspace, self.session, self.runtime = (hello[k] for k in ("workspace", "session", "runtime"))
        capabilities = hello.get("capabilities", [])
        if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
            self.fail("Invalid runtime capabilities.")
            raise ProtocolError(self.failure)
        self.capabilities = set(capabilities)
        limits = hello.get("limits", {})
        self.queue_limit = limits.get("queuedInstructions", 3)
        self.instruction_limit = limits.get("instructionLength", 16000)
        if not (type(self.queue_limit) is int and type(self.instruction_limit) is int and 1 <= self.queue_limit <= 32 and 1 <= self.instruction_limit <= 65536):
            self.fail("Invalid runtime input limits.")
            raise ProtocolError(self.failure)
        snapshot = self.request("snapshot").result(self.timeout + 1)
        with self.lock:
            if self.closed:
                raise ProtocolError(self.failure or "Runtime disconnected during attachment.")
            self.ready = True
        return snapshot

    def request(self, method, params=None, request_id=None):
        future = Future()
        request_id = request_id or str(uuid.uuid4())
        frame = {"v": 1, "id": request_id, "method": method}
        if not self.account:
            frame.update(kind="request", workspace=self.workspace, session=self.session, params=params or {})
        try:
            data = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (ValueError, TypeError, UnicodeError) as error:
            future.set_exception(RuntimeRejected("Request was not sent: " + str(error)))
            return future
        with self.lock:
            if self.closed or len(self.pending) >= (64 if method in CONTROLS else 48) or request_id in self.pending:
                future.set_exception(RuntimeRejected("Request was not sent: LUMI is disconnected or busy. Your draft is preserved."))
                return future
            if len(data) > MAX_FRAME:
                future.set_exception(RuntimeRejected("Request was not sent: it exceeds 256 KiB."))
                return future
            duration = 180 if method == "signIn" else 120 if method.startswith("checkpoint.") else self.timeout
            self.pending[request_id] = (future, method, time.monotonic() + duration)
            try:
                if method not in CONTROLS and self.writes.qsize() >= 12:
                    raise queue.Full
                self.writes.put_nowait((0 if method in CONTROLS else 1, next(self.write_order), data + b"\n"))
            except queue.Full:
                self.pending.pop(request_id)
                future.set_exception(RuntimeRejected("Request was not sent: the control channel is busy. Try again."))
        return future

    def _write(self):
        try:
            while not self.closed:
                try:
                    _, _, data = self.writes.get(timeout=.2)
                except queue.Empty:
                    continue
                view = memoryview(data)
                while view:
                    written = self.process.stdin.write(view)
                    if not written:
                        raise ProtocolError("Control channel closed.")
                    view = view[written:]
        except (OSError, ValueError, ProtocolError) as error:
            self.fail(self.startup_failure() if not self.ready else str(error))

    def _read(self):
        decoder = FrameDecoder()
        try:
            while not self.closed:
                data = self.process.stdout.read(32768)
                if not data:
                    decoder.finish()
                    raise ProtocolError(self.startup_failure() if not self.ready else
                                        "Disconnected. Reconnect to inspect the last confirmed state.")
                for frame in decoder.feed(data):
                    self._receive(frame)
        except (OSError, ValueError, TypeError, ProtocolError, queue.Full) as error:
            self.fail(str(error) or "Runtime display queue exceeded its limit.")
        finally:
            self.process.stdout.close()

    def _receive(self, frame):
        # Future callbacks may close this channel while a decoded burst is being
        # delivered. Serialize that boundary with shutdown and queue admission.
        with self.lock:
            if not self.closed:
                self._receive_open(frame)

    def _receive_open(self, frame):
        if frame.get("kind") == "protocol.error":
            raise ProtocolError("Runtime protocol error. Rebuild app and runtime together.")
        identity = frame.get("id")
        if identity is not None and not isinstance(identity, str):
            raise ProtocolError("Invalid response identity.")
        if identity and not self.account and frame.get("kind") != "response":
            raise ProtocolError("Invalid response envelope.")
        with self.lock:
            pending = self.pending.pop(identity, None)
        if pending:
            future, method, _ = pending
            if future.done():
                return
            error, result = frame.get("error"), frame.get("result")
            if error:
                future.set_exception(RuntimeRejected(error.get("message", str(error)) if isinstance(error, dict) else str(error)))
            elif not isinstance(result, dict):
                future.set_exception(ProtocolError("Invalid runtime response."))
                raise ProtocolError("Invalid runtime response.")
            elif method in ("snapshot", "workspace.attach") and any(
                    result.get(k) != getattr(self, k) for k in ("workspace", "session", "runtime")):
                future.set_exception(ProtocolError("Snapshot belongs to another workspace."))
                raise ProtocolError("Snapshot belongs to another workspace.")
            elif not valid_result(method, result):
                future.set_exception(ProtocolError("Invalid runtime response; reconnect to reconcile recorded state."))
                raise ProtocolError("Invalid runtime response; reconnect to reconcile recorded state.")
            else:
                future.set_result(result)
        elif self.account and frame.get("event") == "browser":
            self.events.put_nowait(frame)
        elif frame.get("kind") == "event" and self.runtime:
            if all(frame.get(k) == getattr(self, k) for k in ("workspace", "session", "runtime")):
                if ("seq" in frame and (type(frame["seq"]) is not int or frame["seq"] < 0)) or not isinstance(frame.get("type"), str):
                    raise ProtocolError("Invalid event sequence.")
                self.events.put_nowait(frame)

    def _watch(self):
        while not self.closed:
            expired_reads = []
            fatal = False
            with self.lock:
                for identity, (future, method, deadline) in list(self.pending.items()):
                    if deadline >= time.monotonic():
                        continue
                    if method in READ_METHODS:
                        self.pending.pop(identity)
                        expired_reads.append((future, method))
                    else:
                        fatal = True
            for future, method in expired_reads:
                if not future.done():
                    future.set_exception(ProtocolError(f"{method} timed out. Reload this view to try again; execution controls remain available."))
            if fatal:
                self.fail("Runtime timed out. Reconnect before retrying; an instruction may already have been accepted.")
            time.sleep(.1)

    def fail(self, message):
        with self.lock:
            if self.closed:
                return
            self.closed, self.ready, self.failure = True, False, message
            pending, self.pending = self.pending, {}
            for mailbox in (self.events, self.writes):
                while True:
                    try:
                        mailbox.get_nowait()
                    except queue.Empty:
                        break
        for future, method, _ in pending.values():
            suffix = " Acceptance unknown; reconnect to reconcile the saved request." if method == "task.submit" else ""
            if not future.done():
                future.set_exception(ProtocolError(message + suffix))
        # EOF invokes runtime cancellation, persistence, owner-lock and child cleanup.
        try:
            self.process.stdin.close()
        except OSError:
            pass
        threading.Thread(target=self._reap, daemon=True).start()

    def _reap(self):
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def close(self):
        if not self.closed:
            self.fail("Workspace closed.")
