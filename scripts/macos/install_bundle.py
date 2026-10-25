"""Install a fully signed bundle by renaming directories, never editing running binaries."""
import os
from pathlib import Path
import plistlib
import shutil
import sys


def heav3ns_bundle(path: Path) -> bool:
    if path.is_symlink():
        return False
    try:
        with (path / "Contents/Info.plist").open("rb") as file:
            return plistlib.load(file).get("CFBundleIdentifier") == "io.heav3ns.code"
    except (OSError, ValueError):
        return False


def install(source: Path, target: Path) -> None:
    if not heav3ns_bundle(source):
        raise ValueError("The staged bundle is not HEAV3NS-CODE.app")
    previous = target.with_name("HEAV3NS-CODE.previous.app")
    # Only the prior generated HEAV3NS-CODE bundle is eligible for build-artifact cleanup.
    for path in (target, previous):
        if path.exists() or path.is_symlink():
            if not heav3ns_bundle(path):
                raise ValueError(f"Refusing to replace an unrelated build artifact: {path}")
    if previous.exists():
        shutil.rmtree(previous)
    had_previous = target.exists()
    if had_previous:
        os.rename(target, previous)
    try:
        os.rename(source, target)
    except OSError:
        if had_previous:
            os.rename(previous, target)
        raise


if __name__ == "__main__":
    install(Path(sys.argv[1]), Path(sys.argv[2]))
