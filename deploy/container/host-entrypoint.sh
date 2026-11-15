#!/usr/bin/env bash
# Entry point of the hexactra host container (#197).
#
# Starts a virtual display (Xvfb) with a window manager, an optional
# password-protected web viewer (x11vnc + noVNC on port 6080), and the
# Hexactra agent in launch mode. The agent starts Chromium on demand with
# the persistent profile in /data/profile. If any of these processes exits,
# the container exits so the restart policy brings it back cleanly.
#
# Environment:
#   HEXACTRA_URL                 control plane URL (required)
#   HEXACTRA_API_TOKEN[_FILE]    API token (required)
#   HEXACTRA_VIEWER_PASSWORD[_FILE]  enables the viewer (VNC passwords use at
#                                most 8 characters; keep the port private)
#   HEXACTRA_SCREEN              Xvfb geometry (default 1440x900x24)
#   HEXACTRA_HOST_NAME, HEXACTRA_IDLE_SHUTDOWN_S, HEXACTRA_LAUNCH_EAGERLY,
#   HEXACTRA_VIEWER_URL          passed to hexactra-agent

set -euo pipefail

log() { printf '[hexactra-host] %s\n' "$*" >&2; }

read_secret() { # NAME -> value of $NAME or of the file in $NAME_FILE
    local name="$1" file_var="${1}_FILE"
    if [[ -n "${!name:-}" ]]; then
        printf '%s' "${!name}"
    elif [[ -n "${!file_var:-}" && -r "${!file_var}" ]]; then
        tr -d '\r\n' < "${!file_var}"
    fi
}

: "${HEXACTRA_URL:?set HEXACTRA_URL to the control plane URL}"
HEXACTRA_API_TOKEN="$(read_secret HEXACTRA_API_TOKEN)"
[[ -n "$HEXACTRA_API_TOKEN" ]] || { log "set HEXACTRA_API_TOKEN or HEXACTRA_API_TOKEN_FILE"; exit 1; }
export HEXACTRA_API_TOKEN

mkdir -p "$XDG_RUNTIME_DIR" /data/profile
chmod 0700 "$XDG_RUNTIME_DIR" /data/profile

pids=()
shutdown() {
    log "stopping"
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait || true
    exit 0
}
trap shutdown TERM INT

# Virtual display. A lock left by an unclean stop would block :99.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 "${HEXACTRA_SCREEN:-1440x900x24}" -nolisten tcp 2>/dev/null &
pids+=($!)
for _ in $(seq 1 50); do
    [[ -e /tmp/.X11-unix/X99 ]] && break
    sleep 0.1
done
[[ -e /tmp/.X11-unix/X99 ]] || { log "Xvfb did not start"; exit 1; }
openbox >/dev/null 2>&1 &
pids+=($!)

# Viewer (optional): VNC on localhost inside the container, noVNC on :6080.
VIEWER_PASSWORD="$(read_secret HEXACTRA_VIEWER_PASSWORD)"
if [[ -n "$VIEWER_PASSWORD" ]]; then
    x11vnc -storepasswd "$VIEWER_PASSWORD" "$XDG_RUNTIME_DIR/vncpass" >/dev/null 2>&1
    x11vnc -display :99 -rfbauth "$XDG_RUNTIME_DIR/vncpass" -localhost -rfbport 5900 \
        -forever -shared -noxdamage -quiet >/dev/null 2>&1 &
    pids+=($!)
    websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 &
    pids+=($!)
    log "viewer on port 6080 (/vnc.html)"
else
    log "viewer disabled (set HEXACTRA_VIEWER_PASSWORD to enable it)"
fi
unset VIEWER_PASSWORD

# The agent launches Chromium on demand (HEXACTRA_BROWSER etc. from the image).
hexactra-agent daemon "$@" &
pids+=($!)
log "agent started; control plane ${HEXACTRA_URL}"

# Exit when any child exits, so the container restarts as a whole.
set +e
wait -n "${pids[@]}"
status=$?
log "a process exited (status $status); stopping the container"
kill -TERM "${pids[@]}" 2>/dev/null
wait
exit "$status"
