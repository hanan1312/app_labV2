# Multi-stage build for this app's two runtime services — the Flask backend and the Node
# WhatsApp/SMS microservice — plus a build-only stage for the React frontend the backend
# serves as static files. Build each service with `docker build --target <name>` (or via
# docker-compose.yml, which does this for you): `backend` and `whatsapp-bot` are the two
# images you actually run; `frontend-builder` only exists to feed `backend`.
#
# These are two independent containers, not one — see docker-compose.yml's own comments for
# why (they don't talk to each other; the browser calls both directly).

# syntax=docker/dockerfile:1.7

########################################
# Stage: frontend-builder
# Builds the React "islands" bundle (frontend-lab/) — see docs/app_react_migration.md — that
# the backend stage below serves as static files. Never runs on its own.
########################################
FROM node:20-slim AS frontend-builder
WORKDIR /build/frontend-lab

# Install from the lockfile only first, so this (slow) layer is cache-hit as long as
# dependencies haven't changed, even when app source below has.
COPY frontend-lab/package.json frontend-lab/package-lock.json ./
RUN npm ci

COPY frontend-lab/ ./
RUN npm run build
# vite.config.ts's outDir ('../src/static/react', relative to frontend-lab/) lands the build
# at /build/src/static/react — Vite creates that directory itself; nothing needs to pre-exist.

########################################
# Stage: backend
# The Flask app (src/main.py). Serves the React bundle above, plus the vanilla-JS pages,
# as static files. Talks to SQLite by default (config.py) — mount a volume over /app/database
# so data survives a container recreation. Never calls the whatsapp-bot service itself (see
# docker-compose.yml) — it only needs to know NODE_PORT to generate config.js for the browser.
########################################
FROM python:3.11-slim AS backend
WORKDIR /app

# reportlab/Pillow/SQLAlchemy etc. all ship manylinux wheels for this base image, so no
# compiler toolchain is needed here — if a future dependency bump changes that, add
# build-essential here rather than to the final image.
RUN pip install --no-cache-dir --upgrade pip

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Everything the Flask app actually reads at runtime — not `COPY . .`, so an unrelated repo
# change (docs, the Node side, CI config) never busts this image's build cache or bloats it.
COPY config.py create_default_users.py check_db.py admins.json ./
COPY src/ ./src/
COPY --from=frontend-builder /build/src/static/react ./src/static/react

COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-entrypoint.sh \
    && useradd --create-home --uid 1000 appuser \
    && mkdir -p database src/static/reports \
    && chown -R appuser:appuser /app
USER appuser

ENV BACKEND_PORT=9050
EXPOSE 9050

ENTRYPOINT ["backend-entrypoint.sh"]
# Same command this app's own systemd unit runs in production (see
# scripts/install_systemd_services.sh) — not gunicorn. Flask's dev server logs a warning
# about that on every boot; if you want a production WSGI server instead, note that this app
# defaults to SQLite (config.py), which doesn't tolerate multiple concurrent *processes*
# writing well — stick to a single worker (e.g. `gunicorn --workers 1 --threads 4`) rather
# than the usual multi-worker setup, or point DATABASE_URL at a real server-based DB first.
CMD ["python", "-m", "src.main"]

########################################
# Stage: whatsapp-bot
# The Node/Express WhatsApp+SMS microservice (src/static/js/server.js, whatsapp-web.js +
# Puppeteer against a system-installed Chromium — see whatsapp.js's PUPPETEER_EXECUTABLE_PATH
# lookup). Needs its QR code scanned once per machine/volume on first boot — that can't be
# automated, it needs a phone in hand: `docker compose logs -f whatsapp-bot`.
########################################
FROM node:20-slim AS whatsapp-bot

# Chromium itself, plus the font packages WhatsApp Web's own UI needs to render text/emoji
# correctly under a headless, otherwise-fontless container (a blank UI is how this fails
# silently without them).
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# whatsapp-web.js pulls in the full `puppeteer` package (not puppeteer-core), whose postinstall
# step tries to download its own bundled Chrome — unneeded (whatsapp.js always launches the
# system Chromium above) and it has no build at all for non-amd64 hosts. Must be set before
# `npm ci` below, same as setup_and_run.sh's own PUPPETEER_SKIP_DOWNLOAD export.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# package.json/package-lock.json live at the repo root, not next to server.js — Node resolves
# node_modules upward from wherever it actually runs (see WORKDIR below), same as bare-metal.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/static/js/server.js src/static/js/whatsapp.js ./src/static/js/

# node:20-slim already ships a non-root `node` user at uid/gid 1000 — reuse it (a fresh
# `useradd --uid 1000` here fails with "UID 1000 is not unique").
RUN mkdir -p src/static/js/.wwebjs_auth src/static/js/.wwebjs_cache \
    && chown -R node:node /app
USER node

# Run with cwd=src/static/js so its relative .wwebjs_auth/.wwebjs_cache paths land where a
# mounted volume expects them — exactly what setup_and_run.sh/install_systemd_services.sh both
# do on bare metal (see their own comments). node_modules still resolves fine three levels up.
WORKDIR /app/src/static/js

ENV NODE_PORT=5050
EXPOSE 5050

CMD ["node", "server.js"]
