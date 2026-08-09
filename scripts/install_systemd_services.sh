#!/bin/bash
#
# Installs this app as two systemd services (Python backend + Node WhatsApp bot), the way
# it's run on a persistent server (e.g. an Oracle Cloud VM) instead of PM2 — systemd's
# Restart=always brings a crashed process back on its own, and the unit is enabled to start
# on boot, so the app survives both a crash and a reboot with no manual step afterward.
#
# Unlike hand-written unit files, every path/user/interpreter below is detected from the
# environment this script actually runs in, not hardcoded — so copying this repo to a new
# path or a new machine (a fresh VM, a different username) doesn't leave stale paths behind
# the way manually-edited unit files do.
#
# Usage:
#   ./setup_and_run.sh                       # installs deps into the venv first, if not done
#   sudo ./scripts/install_systemd_services.sh
#
# Must be run with sudo (writes to /etc/systemd/system and /var/log). Run it again any time
# the repo path, venv, or Node version changes — it's safe to re-run.

set -eo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run this with sudo (it writes to /etc/systemd/system and /var/log)." >&2
    echo "  sudo $0" >&2
    exit 1
fi

# The real (non-root) user and repo path, even under sudo — SUDO_USER/pwd, not root's.
APP_USER="${SUDO_USER:-$(logname 2>/dev/null || whoami)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_NAME="lab_app"
VENV_PYTHON="$SCRIPT_DIR/$ENV_NAME/bin/python"
LOG_DIR="/var/log/lab_app"

# Same override convention as setup_and_run.sh: BACKEND_PORT=8080 NODE_PORT=4000 sudo -E
# ./scripts/install_systemd_services.sh. Baked into the unit files via Environment= below —
# systemd doesn't inherit this shell's env otherwise, unlike PM2 which does.
BACKEND_PORT="${BACKEND_PORT:-9050}"
NODE_PORT="${NODE_PORT:-5050}"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "ERROR: $VENV_PYTHON not found." >&2
    echo "Run ./setup_and_run.sh once first (as $APP_USER, not root) to create the venv and" >&2
    echo "install dependencies, then re-run this script." >&2
    exit 1
fi

# Resolve node as the target user would see it (nvm installs are per-user and not on root's
# PATH), so the unit file gets an absolute path systemd can actually exec — systemd services
# don't source .bashrc/.profile, so relying on PATH at runtime wouldn't work even if this
# script's own PATH happens to resolve it.
#
# Source nvm.sh directly rather than going through a login shell (bash -lc): nvm's installer
# appends its init lines to ~/.bashrc, which only runs for *interactive* shells — a
# non-interactive login shell skips them (same reasoning as setup_and_run.sh's own nvm block).
NODE_BIN="$(sudo -u "$APP_USER" bash -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    command -v node
' 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: couldn't resolve 'node' for user $APP_USER (checked via their login shell, e.g. nvm)." >&2
    echo "Make sure Node is installed for that user (./setup_and_run.sh installs it via nvm if missing), then re-run." >&2
    exit 1
fi

# src/static/js/whatsapp.js launches a system-installed Chromium (falls back to
# /usr/bin/chromium if unset) — same detection as setup_and_run.sh's npm-install step, needed
# here too since systemd doesn't inherit whatever that step exported for this shell.
if [ -z "$PUPPETEER_EXECUTABLE_PATH" ]; then
    for candidate in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium /usr/bin/google-chrome-stable /usr/bin/google-chrome; do
        if [ -x "$candidate" ]; then
            PUPPETEER_EXECUTABLE_PATH="$candidate"
            break
        fi
    done
fi
if [ -z "$PUPPETEER_EXECUTABLE_PATH" ]; then
    echo "WARNING: No system Chromium found — the WhatsApp bot will fail to launch a browser" >&2
    echo "         until one is installed, e.g.: sudo apt-get install -y chromium-browser" >&2
fi

# setup_and_run.sh's own instructions say to run it once first to install deps — but it also
# starts PM2-managed copies of both services as a side effect. Leaving those running alongside
# the systemd units below means two process managers fight over the same ports: whichever one
# is currently bound serves traffic while the other crash-loops (Restart=always/PM2 respawn),
# silently wiping in-memory state (login-lockout counters, presence tracking) on every retry —
# this is what caused the flaky login/session behavior seen on the server but not locally
# (locally there's only ever PM2, never both). Stop any PM2 process pointing at this repo
# before systemd takes the ports, so systemd is the sole owner from here on.
PM2_BIN="$(sudo -u "$APP_USER" bash -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    command -v pm2
' 2>/dev/null || true)"
if [ -n "$PM2_BIN" ]; then
    CONFLICTING_PM2_NAMES="$(sudo -u "$APP_USER" "$PM2_BIN" jlist 2>/dev/null | "$VENV_PYTHON" -c '
import json, sys
try:
    procs = json.load(sys.stdin)
except Exception:
    procs = []
repo = sys.argv[1]
for p in procs:
    env = p.get("pm2_env") or {}
    if str(env.get("pm_exec_path", "")).startswith(repo) or str(env.get("pm_cwd", "")).startswith(repo):
        print(p.get("name", ""))
' "$SCRIPT_DIR" 2>/dev/null || true)"
    if [ -n "$CONFLICTING_PM2_NAMES" ]; then
        echo "--> Found PM2-managed instance(s) of this app — stopping them (systemd is taking over):"
        while IFS= read -r pm2_name; do
            [ -z "$pm2_name" ] && continue
            echo "    - $pm2_name"
            sudo -u "$APP_USER" "$PM2_BIN" delete "$pm2_name" 2>/dev/null || true
        done <<< "$CONFLICTING_PM2_NAMES"
        sudo -u "$APP_USER" "$PM2_BIN" save 2>/dev/null || true
    fi
fi

echo "========================================"
echo " Installing systemd services"
echo "========================================"
echo "  App directory: $SCRIPT_DIR"
echo "  Running as:    $APP_USER"
echo "  Python:        $VENV_PYTHON"
echo "  Node:          $NODE_BIN"
echo "  Logs:          $LOG_DIR"
echo "  Backend port:  $BACKEND_PORT"
echo "  Node port:     $NODE_PORT"
echo "  Chromium:      ${PUPPETEER_EXECUTABLE_PATH:-<not found>}"
echo "========================================"

mkdir -p "$LOG_DIR"
chown "$APP_USER":"$APP_USER" "$LOG_DIR"

cat > /etc/systemd/system/lab_python_port.service <<EOF
[Unit]
Description=Lab App - Python Backend
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$SCRIPT_DIR
Environment=BACKEND_PORT=$BACKEND_PORT
ExecStart=$VENV_PYTHON -m src.main
Restart=always
RestartSec=5

StandardOutput=append:$LOG_DIR/python_out.log
StandardError=append:$LOG_DIR/python_err.log

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/lab_node_port.service <<EOF
[Unit]
Description=Lab App - Node WhatsApp Bot
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$SCRIPT_DIR/src/static/js
Environment=NODE_PORT=$NODE_PORT
Environment=PUPPETEER_EXECUTABLE_PATH=$PUPPETEER_EXECUTABLE_PATH
ExecStart=$NODE_BIN $SCRIPT_DIR/src/static/js/server.js
Restart=always
RestartSec=5

StandardOutput=append:$LOG_DIR/node_out.log
StandardError=append:$LOG_DIR/node_err.log

[Install]
WantedBy=multi-user.target
EOF

echo "--> Wrote /etc/systemd/system/lab_python_port.service and lab_node_port.service"

systemctl daemon-reload
systemctl enable lab_python_port.service lab_node_port.service
systemctl restart lab_python_port.service lab_node_port.service

echo "========================================"
echo " Done. Both services are running and will:"
echo "   - restart automatically if they crash (Restart=always)"
echo "   - start automatically on boot (systemctl enable)"
echo "========================================"
echo "Check status:   systemctl status lab_python_port.service lab_node_port.service"
echo "Watch logs:     tail -f $LOG_DIR/python_out.log"
echo "                tail -f $LOG_DIR/node_out.log"
echo "Restart both:   sudo systemctl restart lab_python_port.service lab_node_port.service"
echo ""
echo "NOTE: the WhatsApp bot needs its QR code scanned once per machine (see node_out.log"
echo "the first time it starts) — this can't be automated, it needs a phone in hand."
