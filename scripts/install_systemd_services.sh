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
NODE_BIN="$(sudo -u "$APP_USER" bash -lc 'command -v node' 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: couldn't resolve 'node' for user $APP_USER (checked via their login shell, e.g. nvm)." >&2
    echo "Make sure Node is installed for that user (./setup_and_run.sh installs it via nvm if missing), then re-run." >&2
    exit 1
fi

echo "========================================"
echo " Installing systemd services"
echo "========================================"
echo "  App directory: $SCRIPT_DIR"
echo "  Running as:    $APP_USER"
echo "  Python:        $VENV_PYTHON"
echo "  Node:          $NODE_BIN"
echo "  Logs:          $LOG_DIR"
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
echo "Check status:   systemctl status lab_python.service lab_node.service"
echo "Watch logs:     tail -f $LOG_DIR/python_out.log"
echo "                tail -f $LOG_DIR/node_out.log"
echo "Restart both:   sudo systemctl restart lab_python.service lab_node.service"
echo ""
echo "NOTE: the WhatsApp bot needs its QR code scanned once per machine (see node_out.log"
echo "the first time it starts) — this can't be automated, it needs a phone in hand."
