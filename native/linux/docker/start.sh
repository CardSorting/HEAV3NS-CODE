#!/bin/bash
# Supervise the desktop and let its workers persist state before X/DBus exit.
set -euo pipefail
mkdir -p "$HOME/Projects" "$HOME/.local/state" /tmp/runtime-desktop
chmod 700 /tmp/runtime-desktop
export XDG_RUNTIME_DIR=/tmp/runtime-desktop
desktop_pid=''
surface_pids=()
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$desktop_pid" ]]; then
    kill -TERM -- "-$desktop_pid" 2>/dev/null || true
    # The DBus wrapper can exit before the worker finishes. Wait for the entire
    # session process group, not only its leader. Never delete ownership locks.
    for attempt in {1..200}; do
      kill -0 -- "-$desktop_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$desktop_pid" 2>/dev/null || true
    wait "$desktop_pid" 2>/dev/null || true
  fi
  for pid in "${surface_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' INT TERM
Xvfb :0 -screen 0 1440x900x24 -nolisten tcp &
surface_pids+=("$!")
for attempt in {1..50}; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display :0 >/dev/null
openbox >/tmp/openbox.log 2>&1 &
surface_pids+=("$!")
x11vnc -display :0 -localhost -rfbport 5900 -forever -shared -nopw -quiet >/tmp/vnc.log 2>&1 &
surface_pids+=("$!")
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/viewer.log 2>&1 &
surface_pids+=("$!")
if [[ -n "${HEAV3NS_PROJECT:-}" ]]; then
  mkdir -p "$HEAV3NS_PROJECT"
  setsid dbus-run-session -- /opt/heav3ns/heav3ns-code "$HEAV3NS_PROJECT" &
else
  setsid dbus-run-session -- /opt/heav3ns/heav3ns-code &
fi
desktop_pid=$!
wait -n
