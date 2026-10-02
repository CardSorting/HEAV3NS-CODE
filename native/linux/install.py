#!/usr/bin/env python3
"""Install an extracted release for the current Linux user; never requires root."""
import os
from pathlib import Path
import shutil
import sys
import tempfile

if sys.platform != "linux":
    sys.exit("Install this release on Linux.")
source = Path(__file__).resolve().parent
if not (source / "runtime/node").is_file():
    sys.exit("Run install.py from an extracted Linux release, not the source tree.")
xdg = os.environ.get("XDG_DATA_HOME", "")
data = Path(xdg) if os.path.isabs(xdg) else Path.home() / ".local/share"
destination = data / "heav3ns-code"
# Versioned installation keeps an already-running worker's files intact.
import hashlib
digest = hashlib.sha256()
for file in sorted(source.rglob("*")):
    if file.is_file() and "__pycache__" not in file.parts and not file.name.startswith("._"):
        digest.update(str(file.relative_to(source)).encode())
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
release = digest.hexdigest()[:16]
target = destination / release
destination.mkdir(parents=True, exist_ok=True)
if not target.exists():
    with tempfile.TemporaryDirectory(prefix="install-", dir=destination) as temporary:
        staged = Path(temporary) / release
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "._*"))
        staged.rename(target)
bin_dir = Path.home() / ".local/bin"
bin_dir.mkdir(parents=True, exist_ok=True)
launcher = bin_dir / "heav3ns-code"
if launcher.exists() and not launcher.is_symlink():
    sys.exit(f"Refusing to replace an existing file: {launcher}")
if launcher.is_symlink():
    launcher.unlink()
launcher.symlink_to(target / "heav3ns-code")
applications = data / "applications"
applications.mkdir(parents=True, exist_ok=True)
# Desktop Entry Exec quoting is not shell quoting. Escape reserved characters and %.
executable = str(target / "heav3ns-code").replace("%", "%%")
for char in ("\\", '"', "`", "$"):
    executable = executable.replace(char, "\\" + char)
entry = (source / "io.heav3ns.Code.desktop").read_text().replace("Exec=heav3ns-code %F", f'Exec="{executable}" %F')
(applications / "io.heav3ns.Code.desktop").write_text(entry)
icons = data / "icons/hicolor/256x256/apps"
icons.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / "share/icons/hicolor/256x256/apps/io.heav3ns.Code.png", icons)
print(f"Installed {target}\nLaunch HEAV3NS-CODE from your applications menu or {launcher}")
