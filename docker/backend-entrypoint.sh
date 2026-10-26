#!/bin/sh
# Runs at container start, before the CMD it hands off to — mirrors the two setup steps
# setup_and_run.sh does right before starting the Flask process (see that script's own
# comments). Both are safe to re-run on every container start:
#   - config.js is just overwritten with whatever BACKEND_PORT/NODE_PORT this container was
#     given, so a port change only needs a container restart, never a rebuild.
#   - create_default_users.py only syncs admins.json into the users table; it's idempotent.
set -e

: "${BACKEND_PORT:=9050}"
: "${NODE_PORT:=5050}"

echo "--> Writing runtime port config for frontend JS (src/static/js/config.js)..."
cat > src/static/js/config.js <<EOF
// Auto-generated at container start from BACKEND_PORT/NODE_PORT — do not edit directly.
window.APP_PORTS = { backend: ${BACKEND_PORT}, node: ${NODE_PORT} };
EOF

echo "--> Syncing admin users from admins.json (safe to re-run)..."
python create_default_users.py

exec "$@"
