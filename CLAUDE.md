# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Flask + vanilla-JS desk app, originally a **Pediatric Clinic Management System**, transformed (see `LAB_TRANSFORMATION_README.md`) into a **Medical Analysis Laboratory Management System**. Both the original "clinic" domain and the new "lab" domain still live side by side in the same codebase as a "dual-workspace" system — see Architecture below.

## Commands

```bash
# Setup (creates venv 'lab_app', installs Python + Node deps, initializes DB, starts both
# services under PM2: the Flask app as "python-bot" and the WhatsApp bot as "whatsapp-bot")
./setup_and_run.sh

# Manual run (from a venv with requirements.txt installed)
python -m src.main                      # Flask app on http://0.0.0.0:9050

# Initialize DB tables + sync admin users from admins.json (safe to re-run)
python create_default_users.py

# Inspect the sqlite schema directly
python check_db.py

# WhatsApp/SMS microservice (Node/Express, lives in src/static/js/)
cd src/static/js && npm install
node server.js                          # or: pm2 start server.js --name whatsapp-bot
```

There is no test suite, linter, or frontend build step in this repo — the frontend is served directly as static HTML/CSS/JS (no bundler, no npm deps for the frontend itself; the only `package.json` is for the WhatsApp microservice).

## Architecture

### Two workspaces, currently one database

The app supports switching between a **clinic** workspace and a **lab** workspace (`session['workspace']`, header `X-App-Mode`), each with its own models, routes, and frontend (`index.html`/`script.js` for clinic, `index_lab.html`/`script_lab.js` for lab). `src/main.py`'s `bind_database()` `before_request` hook rebinds `db.session.bind` per-request based on the active workspace.

**Important gotcha:** `app.clinic_engine` and `app.lab_engine` (set up in `src/main.py`) are both currently created from the *same* `clinic_uri` (`database/app.db`) — the separate `lab_uri`/`database/lab.db` variable is computed but unused. So despite the "dual database" design intent, clinic and lab tables today all live in the single `database/app.db` SQLite file. Don't assume workspace switching implies data isolation unless this is fixed.

Login usernames are prefix-routed: `clnc_*` → clinic workspace, `lab_*` → lab workspace (`src/routes/user.py`). Master admin credentials live in `admins.json` (not in the `users` table) and are checked before the DB — a `master_*` session `user_id` bypasses normal user lookups. Master admin users are also the only ones who can see/use the workspace switcher (`is_workspace_switcher_enabled()`) or hit `/api/workspace/change`.

### Models: clinic vs. lab, plus shared/global tables

- Clinic domain (legacy, retained for backward compatibility): `Patient` (`src/models/patient.py`), `ClinicConfig`, `Reservation`.
- Lab domain (current primary product): `Client` (`src/models/client.py`, the lab equivalent of `Patient`), `TestResult`, `LabConfig`.
- Shared across both workspaces, defined directly in `src/models/user.py` alongside `User`: `LabTest`, `TransactionList`, `PatientVisit` (FK to `clients.id` — despite the clinic-sounding name, this is the lab visit/order-history table), `WarehouseItem`, `WarehouseBill`, `Employee`.
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

### Presence / session behavior

`main.py` maintains an in-memory `PRESENCE_STORE` (not persisted) updated via `POST /api/auth/presence`. The `before_request` hook uses it to force-expire a session (`session.clear()`, 401) if a user has been offline/idle past `PRESENCE_TIMEOUT_SECONDS` (16 min) — this is separate from the per-lab `force_logout_time`/`idle_logout_timeout` settings stored on `LabConfig`.

### WhatsApp/SMS microservice

`src/static/js/server.js` is a standalone Express service (using `whatsapp-web.js`) providing `/api/whatsapp/send`, `/api/sms/send` (SMS is a stub — no provider wired up), and status endpoints. It's independent of the Flask app and run separately (via PM2 per `setup_and_run.sh`). Session data for WhatsApp Web auth is persisted in `.wwebjs_auth/`; `whatsapp.js` has self-healing logic that wipes that folder and force-exits (for PM2 to restart) if a session goes stale.

### Frontend

No build step: `index_lab.html` + `src/static/js/script_lab.js` (~5000 lines) is the lab SPA; `index.html` + `script.js` is the legacy clinic SPA. Both are plain JS hitting the Flask JSON API directly. i18n strings for the lab UI live in `src/static/translations.json` under top-level `EN`/`AR` keys, organized by page/section. `GET /api/features` exposes feature flags (currently just `workspace_switcher`) to the frontend.
