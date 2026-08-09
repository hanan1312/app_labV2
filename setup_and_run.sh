#!/bin/bash
#
# One-command bootstrap for this app: creates/repairs the Python venv, installs every
# dependency (Python + Node), initializes the database, and starts both services under PM2.
# Safe to re-run any time — every step is idempotent.
#
# Works from any checkout location and any invocation directory (dev laptop, a fresh VM,
# CI, etc.) since it always cd's into its own directory first.
#
# For a production box you want managed by systemd instead of PM2 (e.g. a cloud VM that
# must survive reboots without a manual `pm2 resurrect`), run this once to install
# dependencies, then use scripts/install_systemd_services.sh instead of the PM2 steps below.
#
# To change ports, set BACKEND_PORT and/or NODE_PORT before running instead of editing code:
#   BACKEND_PORT=8080 NODE_PORT=4000 ./setup_and_run.sh
# This one place drives the Flask port, the Node WhatsApp bot port, their PM2 process names,
# and the frontend JS (via a generated src/static/js/config.js) — nothing else to update.

set -eo pipefail  # no -u: nvm's own install script isn't safe under `set -u` when sourced

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_NAME="lab_app"
BACKEND_PORT="${BACKEND_PORT:-9050}"
NODE_PORT="${NODE_PORT:-5050}"
export BACKEND_PORT NODE_PORT

# PM2 process names bake the port in so a port change can't collide with a stale process
# still registered under the old name.
PYTHON_PM2_NAME="python-bot-${BACKEND_PORT}"
NODE_PM2_NAME="whatsapp-bot-${NODE_PORT}"

echo "========================================"
echo " Starting Lab Management App Setup"
echo " (repo: $SCRIPT_DIR)"
echo "========================================"

# --- 0. CLEAN UP THIS APP'S OWN LEFTOVER PROCESSES ---
# Scoped to processes that clearly belong to this app (its server.js by absolute path, or a
# Puppeteer Chromium launched from its .wwebjs_auth profile) — NOT a blanket `pkill -f node`
# / `pkill -f chromium`, which would kill every Node process and every Chromium instance on
# the machine, including completely unrelated ones (other projects, a remote-desktop
# session, etc.).
echo "--> Cleaning up any leftover processes from a previous run of this app..."
pkill -f "${SCRIPT_DIR}/src/static/js/server.js" 2>/dev/null || true
pkill -f "${SCRIPT_DIR}/src/static/js/.wwebjs_auth" 2>/dev/null || true
rm -f src/static/js/.wwebjs_auth/session-lab/SingletonLock 2>/dev/null || true

# --- 1. PYTHON BACKEND SETUP ---
echo "--> Setting up Python environment..."

recreate_venv() {
    echo "--> (Re)creating virtual environment '$ENV_NAME'..."
    rm -rf "$ENV_NAME"
    python3 -m venv "$ENV_NAME"
}

if [ ! -d "$ENV_NAME" ]; then
    recreate_venv
elif [ ! -x "$ENV_NAME/bin/python" ]; then
    # A venv copied/moved from a different machine or path leaves bin/python as a dangling
    # symlink to an interpreter that no longer exists there — this bit the project once
    # before (docs/sumV2.md, Part 1) and silently made installs operate on the wrong Python.
    # Recreate rather than fail mysteriously later.
    echo "--> Existing virtual environment looks broken (dangling interpreter symlink) — recreating it."
    recreate_venv
else
    echo "--> Virtual environment '$ENV_NAME' already exists and looks healthy."
fi

# Always invoke pip via the venv's python (`python -m pip`), never bin/pip directly — the
# same historical incident found bin/pip's shebang pointing at a stale path even when
# bin/python itself was fine.
echo "--> Upgrading pip..."
"$ENV_NAME/bin/python" -m pip install --upgrade pip --quiet

echo "--> Installing Python dependencies from requirements.txt..."
if [ -f "requirements.txt" ]; then
    "$ENV_NAME/bin/python" -m pip install -r requirements.txt
else
    echo "ERROR: requirements.txt not found!"
    exit 1
fi

echo "--> Initializing database (safe to re-run; syncs admin users from admins.json)..."
if [ -f "create_default_users.py" ]; then
    "$ENV_NAME/bin/python" create_default_users.py
else
    echo "WARNING: create_default_users.py not found. Skipping initialization."
fi

# --- 2. NODE.JS & PM2 SETUP ---
echo "========================================"
echo " Setting up Node.js & PM2"
echo "========================================"

if ! command -v npm &> /dev/null; then
    echo "--> 'npm' is not installed. Installing Node.js via NVM (Node Version Manager)..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
fi

if ! command -v pm2 &> /dev/null; then
    echo "--> Installing PM2 globally..."
    npm install -g pm2
fi

# --- 3. WHATSAPP BOT DEPENDENCIES (NODE) ---
# package.json lives at the repo root (Node resolves node_modules upward from
# src/static/js/server.js regardless of where it physically sits). Installing from the
# manifest here — instead of a hardcoded package list baked into this script — keeps
# dependencies in sync with package.json/package-lock.json automatically as they change.
#
# whatsapp-web.js pulls in Puppeteer, whose postinstall step tries to download its own
# bundled Chrome — which has no build at all for Linux ARM (aarch64/armv7 hosts), and fails
# `npm install` outright. We don't need that browser anyway: src/static/js/whatsapp.js always
# launches a system-installed Chromium via PUPPETEER_EXECUTABLE_PATH. Skip the download and
# point at whichever Chromium binary this host actually has (the package name/path varies —
# "chromium" on some distros, "chromium-browser" on others).
export PUPPETEER_SKIP_DOWNLOAD=true
if [ -z "$PUPPETEER_EXECUTABLE_PATH" ]; then
    for candidate in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium /usr/bin/google-chrome-stable /usr/bin/google-chrome; do
        if [ -x "$candidate" ]; then
            PUPPETEER_EXECUTABLE_PATH="$candidate"
            break
        fi
    done
fi
if [ -n "$PUPPETEER_EXECUTABLE_PATH" ]; then
    echo "--> Using system Chromium at $PUPPETEER_EXECUTABLE_PATH for the WhatsApp bot."
    export PUPPETEER_EXECUTABLE_PATH
else
    echo "WARNING: No system Chromium found (checked chromium, chromium-browser, snap chromium,"
    echo "         google-chrome). The WhatsApp bot will fail to launch a browser until one is"
    echo "         installed, e.g.: sudo apt-get install -y chromium-browser"
fi

echo "--> Installing Node.js dependencies (from package.json)..."
npm install

echo "--> Writing runtime port config for frontend JS (src/static/js/config.js)..."
cat > src/static/js/config.js <<EOF
// Auto-generated by setup_and_run.sh from BACKEND_PORT/NODE_PORT — do not edit directly.
window.APP_PORTS = { backend: ${BACKEND_PORT}, node: ${NODE_PORT} };
EOF

echo "--> Starting WhatsApp Microservice with PM2..."
pm2 stop "$NODE_PM2_NAME" 2>/dev/null || true
pm2 delete "$NODE_PM2_NAME" 2>/dev/null || true
# Run with cwd=src/static/js so its relative .wwebjs_auth/.wwebjs_cache paths land where the
# rest of the app expects them — unaffected by node_modules physically living at repo root.
(cd src/static/js && pm2 start server.js --name "$NODE_PM2_NAME")

# --- 4. FLASK SERVER (PYTHON) ---
echo "--> Starting Python Flask Server with PM2..."
pm2 stop "$PYTHON_PM2_NAME" 2>/dev/null || true
pm2 delete "$PYTHON_PM2_NAME" 2>/dev/null || true
pm2 start "$ENV_NAME/bin/python" --name "$PYTHON_PM2_NAME" -- -m src.main

# --- 5. PERSIST ACROSS REBOOTS ---
echo "--> Saving PM2 process list..."
pm2 save

if ! systemctl list-unit-files 2>/dev/null | grep -q "pm2-$(whoami)"; then
    echo "--------------------------------------------------------------"
    echo " NOTE: PM2 isn't yet configured to start on boot for this user."
    echo " 'pm2 save' only restores this process list once PM2 itself is"
    echo " running again — a reboot won't bring PM2 back up on its own"
    echo " without a one-time extra step. Run 'pm2 startup', then run"
    echo " the sudo command it prints, then 'pm2 save' once more."
    echo ""
    echo " For a production box, scripts/install_systemd_services.sh is"
    echo " an alternative to PM2 that's reboot-safe out of the box"
    echo " (systemd manages the processes directly — no 'pm2 startup'"
    echo " step needed at all)."
    echo "--------------------------------------------------------------"
fi

# --- 6. FINALIZE & LOGS ---
echo "========================================"
echo " Application Servers Started Successfully!"
echo "========================================"
echo "Check status:  pm2 status"
echo "Python logs:   pm2 logs $PYTHON_PM2_NAME"
echo "WhatsApp logs: pm2 logs $NODE_PM2_NAME"
echo ""
echo "--> Displaying live logs for the WhatsApp Bot (Ctrl+C to exit — the app keeps running)..."
pm2 logs "$NODE_PM2_NAME"
