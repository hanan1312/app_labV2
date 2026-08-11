# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Flask + vanilla-JS desk app, originally a **Pediatric Clinic Management System**, transformed (see `LAB_TRANSFORMATION_README.md`) into a **Medical Analysis Laboratory Management System**. Both the original "clinic" domain and the new "lab" domain still live side by side in the same codebase as a "dual-workspace" system — see Architecture below.

## Commands

```bash
# Setup (creates venv 'lab_app', installs Python + Node deps, initializes DB, starts both
# services under PM2: Flask as "python-bot-<port>", WhatsApp bot as "whatsapp-bot-<port>").
# Ports default to 9050/5050 — override instead of editing code:
#   BACKEND_PORT=8080 NODE_PORT=4000 ./setup_and_run.sh
./setup_and_run.sh

# Production alternative to PM2 — systemd services (Restart=always, survives reboots), same
# BACKEND_PORT/NODE_PORT override convention. Auto-detects a system Chromium for the WhatsApp
# bot and stops any PM2-managed instance of this app before taking the ports over — running
# both process managers against the same ports at once is what caused a real flaky-session bug
# (see Presence/session behavior below for the unrelated deeper cause it also exposed).
sudo ./scripts/install_systemd_services.sh

# Manual run (from a venv with requirements.txt installed)
python -m src.main                      # Flask app on http://0.0.0.0:$BACKEND_PORT (default 9050)

# Initialize DB tables + sync admin users from admins.json (safe to re-run)
python create_default_users.py

# Inspect the sqlite schema directly
python check_db.py

# Synthetic demo/load-test data. seed_synthetic_data.py writes to whatever DATABASE_URL (or
# the default database/app.db) resolves to, and --clear WIPES existing clients/visits/tests/
# transactions/warehouse data — verify against a copy first (see its own docstring).
# seed_expiry_batches.py is safe by default instead: it always copies the database before
# touching anything and only ever edits the copy, never the original unless you pass --in-place.
python scripts/seed_synthetic_data.py --patients 2000 --clear
python scripts/seed_expiry_batches.py

# WhatsApp/SMS microservice (Node/Express, lives in src/static/js/)
cd src/static/js && npm install
node server.js                          # or: pm2 start server.js --name whatsapp-bot
```

There is no test suite, linter, or frontend build step in this repo — the frontend is served directly as static HTML/CSS/JS (no bundler, no npm deps for the frontend itself; the only `package.json` is for the WhatsApp microservice).

`lab_app/` (the venv), `database/` (SQLite files + backups), and `src/static/js/.wwebjs_auth/`/`.wwebjs_cache/` (WhatsApp session/cache) are gitignored — they used to be committed, which meant a `git pull` could silently overwrite a server's live database or WhatsApp login with whatever was last committed from a different machine. A fresh clone must run `./setup_and_run.sh` (or `create_default_users.py`) to create them; nothing under those paths ever comes from git.

## Architecture

### Two workspaces, currently one database

The app supports switching between a **clinic** workspace and a **lab** workspace (`session['workspace']`, header `X-App-Mode`), each with its own models, routes, and frontend (`index.html`/`script.js` for clinic, `index_lab.html`/`script_lab.js` for lab). `src/main.py`'s `bind_database()` `before_request` hook rebinds `db.session.bind` per-request based on the active workspace.

**Important gotcha:** `app.clinic_engine` and `app.lab_engine` (set up in `src/main.py`) both end up pointing at the same file, `database/app.db` — but via two different mechanisms, which matters if you ever need to redirect the database (e.g. testing against a copy). `clinic_engine` uses `app.config['SQLALCHEMY_DATABASE_URI']`, which *does* respect a `DATABASE_URL` env var override. `lab_engine` uses a separately hardcoded `os.path.join(DB_DIR, 'app.db')` (the variable is named `lab_uri`/`lab_db_path` but never actually points at `lab.db`) — it does **not** respect `DATABASE_URL` at all. Any code path that explicitly does `db.session.bind = app.lab_engine` (the `before_request_interceptor`, for a request in the lab workspace) always hits the real file no matter what env var is set. A standalone script that never touches `db.session.bind` (e.g. `seed_synthetic_data.py`, `seed_expiry_batches.py`) is unaffected — it uses the default bind, which does follow `DATABASE_URL` — but don't assume that generalizes to request-handling code. Despite the dual-engine design intent, clinic and lab tables today all live in this single file; don't assume workspace switching implies data isolation unless this is fixed.

Login usernames are prefix-routed: `clnc_*` → clinic workspace, `lab_*` → lab workspace (`src/routes/user.py`). Master admin credentials live in `admins.json` (not in the `users` table) and are checked before the DB — a `master_*` session `user_id` bypasses normal user lookups. Master admin users are also the only ones who can see/use the workspace switcher (`is_workspace_switcher_enabled()`) or hit `/api/workspace/change`.

### Models: clinic vs. lab, plus shared/global tables

- Clinic domain (legacy, retained for backward compatibility): `Patient` (`src/models/patient.py`), `ClinicConfig`, `Reservation`.
- Lab domain (current primary product): `Client` (`src/models/client.py`, the lab equivalent of `Patient`), `TestResult`, `LabConfig`.
- Shared across both workspaces, defined directly in `src/models/user.py` alongside `User`: `LabTest`, `TransactionList`, `PatientVisit` (FK to `clients.id` — despite the clinic-sounding name, this is the lab visit/order-history table), `WarehouseItem`, `WarehouseBill`, `WarehouseWorkOrder`, `WarehouseBatch`, `WarehouseWorkOrderScan`, `Employee`. See Warehouse below for how the last three fit together.
- `Financial` (`src/models/financial.py`) defines `ServiceType`/`Transaction`, used by the clinic-side financial routes; `PatientVisit`/`TransactionList` in `user.py` are the lab-side equivalent used by the newer transaction/visit endpoints added directly in `main.py`.
- **`src/models/employee.py` is dead code.** The real `Employee` model the app uses is the one declared inline in `src/models/user.py` (imported via `from src.models.user import ... Employee`); the standalone file is not imported anywhere and has drifted out of sync (missing `username`, different `join_date` default).

### Routes

Blueprints are registered in `src/main.py`:
- `user_bp` → `/api/auth` (auth, login/logout, permissions)
- `patient_bp`, `clinic_bp` → `/api` (legacy clinic domain)
- `client_bp`, `test_result_bp`, `lab_bp` → `/api` (lab domain: clients, test results, lab config)
- `financial_bp` → `/api/financial`

A large and growing set of endpoints (users CRUD, `LabTest` CRUD, transactions/visits, warehouse inventory + purchase bills, HR/employees, presence tracking, report PDF upload, workspace switching) is defined **directly in `src/main.py`** rather than in a blueprint module — check there first for anything not obviously covered by a `src/routes/*.py` file.

PDF generation (lab reports, client history reports) uses ReportLab and is implemented in `src/routes/client.py`; uploaded lab report PDFs are stored under `src/static/reports/` and linked via `PatientVisit.report_url` (comma-separated list of relative paths).

### Warehouse: bills, batches, and work orders

Three linked concepts, all defined in `src/models/user.py` and routed directly in `src/main.py` (no blueprint). Every route requires `require_permission('warehouse')` at minimum.

- **`WarehouseBill`** — stock coming IN via purchase. Status lifecycle `demanded → ordered → delivered` via `PUT /api/warehouse/bills/<id>/status` (or the `/bulk-bills/...` equivalent for a grouped order). Any warehouse user can set `demanded`/`delivered`; only admins/masters can set `ordered` ("Confirmed" in the UI) — enforced in `update_bill_status()`, not just hidden client-side. Marking a bill `delivered` does **not** touch stock by itself anymore (it used to — an old "Magic" auto-increment, removed when batches were introduced); it's now purely a paperwork status.
- **`WarehouseBatch`** — the actual unit of stock. One row per delivery, created via `POST /api/warehouse/bills/<id>/receive` once a bill is `delivered` — this is the *only* thing that increments `WarehouseItem.quantity` now. Carries an `expiry_date` and a unique `barcode` (minted server-side as `WB-{id:06d}-{6 hex chars}`, resolved by DB lookup on scan — the code itself is never parsed for meaning). "Expired" is derived (`status == 'active' and expiry_date < today`), never stored, so it can't go stale without a cron job. Expired batches are excluded from normal FEFO availability; an admin must confirm disposal (`POST /api/warehouse/batches/<id>/dispose`, requires a reason) to remove their remaining quantity from stock.
- **`WarehouseWorkOrder`** — stock going OUT for use. Lifecycle `requested` (no stock effect) → `approved` (admin, via `.../approve`) → `completed` (reached by scanning batch barcodes against `.../scan`, one unit deducted per successful scan) or `rejected` (admin, no stock effect ever). Each scan enforces FEFO server-side: scanning a batch while an *older*, still-valid batch of the same item is available returns 409 with `"check shelf for older item of the same name please!"` unless resent with `confirm_fefo_override: true`; scanning an *already-expired* batch is always a hard 400, never just a warning. `WarehouseWorkOrderScan` is the resulting per-scan audit trail (who, when, whether it broke FEFO).

Barcode scanning targets a USB/Bluetooth HID scanner (keyboard-wedge: types the code + Enter into whatever has focus), not a camera — there's no barcode-decoding JS library in this codebase. `script_lab.js`'s "Fulfill via Scan" modal just listens for Enter on a focused, auto-refocusing text input.

**Migration note worth generalizing:** `WarehouseWorkOrder` gained `status`/`quantity_fulfilled`/`approved_by`/`approved_at` after this lifecycle was added. The usual blind per-statement `ALTER TABLE ... DEFAULT` (see the loops earlier in `main.py`'s startup) would default every *pre-existing* row to `status='requested'` — but those rows were created under the old immediate-deduction model, so their stock was already removed at creation time; coming back as `'requested'` would let someone re-approve and re-scan them, double-deducting the same stock. The actual migration is guarded (checks whether the `status` column exists yet before running) and explicitly backfills every pre-existing row to `'completed'` in that same block, before any genuinely new `'requested'` row can exist to be confused with one. Any future column added to a table with rows that predate it should ask the same question: does the DEFAULT value mean something different for old rows than for new ones?

### Presence / session behavior

`main.py` maintains an in-memory `PRESENCE_STORE` (not persisted — resets on every restart) updated via `POST /api/auth/presence`. `before_request_interceptor` force-expires a session (`session.clear()`, 401) only when a user's last heartbeat is older than `PRESENCE_TIMEOUT_SECONDS` (16 min) — **not** on an explicit `status == 'offline'` report anymore, and only for non-admin/non-master users (same exemption as the scheduled `force_logout_time`/`idle_logout_timeout` window on `LabConfig`, a separate mechanism).

The explicit-offline-report trigger was removed deliberately: the client reports `'offline'` via `navigator.sendBeacon` on `beforeunload`, and a beacon queued while the network is down can be delivered by the browser later — carrying whatever session cookie is current *at delivery time*. If the user reconnects and logs back in before that queued beacon lands, it arrives tagged with the *new* session and would retroactively kill it. Time-based-only enforcement closes that race, since an actively-used session keeps its own `last_seen` fresh regardless of what a stale queued signal claims. `login()` in `src/routes/user.py` also always resets `PRESENCE_STORE` to `'online'` on success (`_mark_online()`), so a stale flag left by any prior session (idle timeout, manual logout, or this same race) can never poison a fresh login.

### WhatsApp/SMS microservice

`src/static/js/server.js` is a standalone Express service (using `whatsapp-web.js`) providing `/api/whatsapp/send`, `/api/sms/send` (SMS is a stub — no provider wired up), and status endpoints. It's independent of the Flask app and run separately (via PM2 or systemd, per `setup_and_run.sh`/`install_systemd_services.sh`). Port comes from `NODE_PORT` (default 5050). Session data for WhatsApp Web auth is persisted in `.wwebjs_auth/`; `whatsapp.js` has self-healing logic that wipes that folder and force-exits (for the process manager to restart it) if a session goes stale. Puppeteer launches a *system-installed* Chromium (`PUPPETEER_EXECUTABLE_PATH`, auto-detected by both launcher scripts — falls back to `/usr/bin/chromium`) rather than its own bundled download, since Chrome-for-Testing has no build at all for Linux ARM hosts.

### Frontend

No build step: `index_lab.html` + `src/static/js/script_lab.js` (~6000+ lines) is the lab SPA; `index.html` + `script.js` is the legacy clinic SPA. Both are plain JS hitting the Flask JSON API directly. i18n strings for the lab UI live in `src/static/translations.json` under top-level `EN`/`AR` keys, organized by page/section. `GET /api/features` exposes feature flags (currently just `workspace_switcher`) to the frontend.

Backend/WhatsApp-bot ports are never hardcoded in the frontend as literal `:9050`/`:5050` strings — `setup_and_run.sh` generates `src/static/js/config.js` (gitignored, regenerated on every run) containing `window.APP_PORTS = {backend, node}`, included via a `<script>` tag before `script_lab.js`/`results_entry.js` in the HTML. Changing `BACKEND_PORT`/`NODE_PORT` and re-running the setup script is the only thing that needs to happen — no source edits.
