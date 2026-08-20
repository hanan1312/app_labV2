# Results-Approval Workflow, CBC Report Redesign, and Related Fixes

What was built in this working session. Written as a reference for picking this work back up
later — what changed, where, why, and the gotchas that came out of it.

## Schema changes

No Alembic in this repo — every column below was added via the guarded per-statement
`ALTER TABLE` pattern in `src/main.py`'s startup loop (run against both `app.lab_engine` and
`app.clinic_engine`), same convention documented in `CLAUDE.md`.

| Table | New column(s) | Notes |
|---|---|---|
| `lab_config` | `require_results_approval` | `BOOLEAN DEFAULT 0` — existing labs keep today's auto-send behavior on upgrade. |
| `patient_visits` | `approval_status`, `approved_by`, `approved_at` | `approval_status` is `NULL` / `'not_required'` / `'pending_approval'` / `'approved'` — a **separate column from the existing `status`** (which already carries delivery-state strings other code branches on). No backfill needed: brand-new concepts, `NULL` always meant and still means "not applicable/not yet decided." |
| `test_parameter_templates` | `category`, `parent_parameter_id` | `category` is a free-text report-section label (e.g. "Blood Picture"), never pattern-matched by value — only ever a display heading. `parent_parameter_id` is a self-referential FK (`ON DELETE SET NULL`) capped at one level of nesting (e.g. "Segmented"/"Band" under "Neutrophil"). Both `NULL` for every pre-existing row — no backfill needed, same reasoning as above. |

## Test-booking search (`script_lab.js`)

The "Book Tests" modal's checkbox list had no search box. Added one, mirroring the existing
"Check Tests Total Price" tab's pattern (`renderPriceCheckTests`/`priceCheckSelectedTests`):
selections are tracked in a persisted object (`bookTestSelectedTests`, name → `{price,
sample_type}`) rather than read back from the DOM, so filtering the list on a search keystroke
never silently drops an already-checked test. `renderBookTestCheckboxes()` is the extracted
render function; `applyPanelQuickSelect()` and `submitTestBooking()` were updated to read/write
the same object instead of raw `.test-checkbox:checked` DOM state (which also fixed a latent
bug where that unscoped selector could pick up stray checkboxes from the unrelated Test List
bulk-delete table).

## Patient-name sync bug (`src/main.py`)

`PatientVisit.patient_name` / `TransactionList.patient_name` are name **snapshots** taken once
at booking time and never refreshed — editing a `Client`'s name later left Test Results and
Transaction History showing the old name forever. Root cause: `get_all_visits()` and
`get_all_transactions()` already bulk-fetch the live `Client` row for other fields (e.g.
`phone`) but were still reading the stale snapshot column for the name specifically. Fixed by
building `patient_name` from the live `Client` object at both call sites, falling back to the
snapshot only if the client record was deleted. The snapshot columns themselves are left in
place (not removed) as an audit-trail fallback. `reports.py`'s report-generation path was
never affected — it already re-joined `Client` fresh.

## Results-approval workflow

### The gate

`LabConfig.require_results_approval` (Settings > Messaging Settings > "Require manual approval
before sending results", default off) decides what happens when a visit's results become
complete, in both entry points:

- `save_results()` (`src/routes/reports.py`)
- `upload_report()` (`src/main.py`)

When **off**: unchanged from before this session — `visit.status = 'results_delivered_by_link'`
immediately, `messaging.enabled` reflects `LabConfig.msg_enabled` as-is.

When **on**: the visit does **not** go straight to "delivered" — it gets a new status,
**`visit.status = 'awaiting_approval'`** (distinct from `approval_status = 'pending_approval'`,
which is a separate column), `messaging.enabled` is forced `False`, and
`Client.sample_status` is *not* set to `'delivered'` yet either (`upload_report()` only sets
it when approval isn't required). The report PDF is still generated and saved as normal in
both cases — approval only gates the messaging send and the "delivered" status labels, not
report generation itself.

### Approving

`POST /api/visits/approve` (`src/main.py`, `approve_pending_results()`) is what finishes the
transition: for each matched visit it sets `approval_status='approved'`, `approved_by`,
`approved_at`, **`visit.status = 'results_delivered_by_link'`**, and
`Client.sample_status = 'delivered'` — this is the only place those two "now actually
delivered" writes happen when approval was required. It always re-filters to
`approval_status == 'pending_approval'` at call time (never trusts the posted id list alone),
so a double-click, a stale view, or two staff approving concurrently can't double-approve.
Body is either `{"visit_ids": [...]}` or `{"approve_all": true}` (server-side "every visit
pending right now," not whatever happened to be rendered client-side).

The route never calls the Node WhatsApp/SMS bot itself — consistent with every other flow in
this app, that HTTP call always happens client-side. It hands back a `messaging`-shaped payload
per visit (phone, method, report URLs) for the frontend to loop over.

### Frontend surfaces

Three ways to approve, all funneling through the same shared sender:

1. **Test Results > Check** (`#check-approvals-btn`, gated by the new `approve_results`
   permission) — opens `#pending-approval-modal`, a simple checkbox list +
   select-all + "Approve & Send Selected" (`approveSelectedResults()`).
2. **Test Results tab's own row click** — the tab gained a **Status filter**
   (`#results-filter-status`: Delivered / Waiting for Approval), and every row is now
   clickable (mirrors the Dashboard's existing whole-row-opens-a-modal convention), opening
   the existing `#visit-results-modal` (`openVisitResultsModal`/`renderVisitResultsModal`,
   originally built for the Dashboard's "click a record" popup). When the opened visit's
   status is `awaiting_approval` **and** the current user has `approve_results`
   (`userCanApproveResults`, set in `setupUIForRole()`), the modal shows an extra bar with
   **"🧪 Enter Results"** (opens `/results-entry/<id>` to correct values first — saving there
   re-runs the same approval-gate logic, so it stays `awaiting_approval` until actually
   approved) and **"✅ Approve & Send"** (`approveVisitFromModal(visitId)`, approves just
   that one visit).
3. Both (1) and (2) call the same **`approveVisitsAndNotify(body)`** core (`script_lab.js`) —
   POSTs to `/api/visits/approve`, loops the returned `results` calling
   **`sendResultsReadyMessage(...)`** for every entry with a phone, and shows one aggregate
   summary toast ("N approved — N sent, N skipped (no phone), N failed") instead of one toast
   per visit. `sendResultsReadyMessage` itself was extracted out of `handleFileUpload()`'s
   inline message-building code so the upload flow, the bulk-approve flow, and the
   single-visit-approve flow all send the exact same Arabic template instead of drifting.

`GET /api/visits/<id>/results-view` (`get_results_view` in `reports.py`) gained `status` and
`approval_status` fields in its response specifically so the modal (opened from either the
Dashboard or Test Results) can decide whether to show the approval bar without the caller
having to thread that state through separately.

### Status display everywhere

`awaiting_approval` needed an explicit branch anywhere `PatientVisit.status` gets turned into a
badge, since the existing `if/else if` chains have no final `else` (an unhandled status
silently falls through to whatever default was initialized, with **no action button at all**).
Added to: `buildAdminTableHTML()`'s badge + action-button chains, the Patient Directory
"Latest Status" column, the Patient History modal rows (also added to the Print-button gating
condition, so staff can still preview/print internally pre-approval), and the "Tests" aggregate
pending/collected counters (`awaiting_approval` counts as collected). Left alone on purpose:
the Dashboard KPI pending/finished counts (different, narrower stage-tracking scope), and
`fetchTestResultsPage()`'s status param is now the dynamic filter described above rather than
a second hardcoded value.

### Permission

New `approve_results` permission. `openAccessModal()` auto-generates one checkbox per sidebar
`.nav-tab` — `approve_results` has none, so it's appended via a small fixed `EXTRA_PERMISSIONS`
list instead of a fake hidden tab. Also fixed along the way: `get_settings_users()`
(`src/routes/user.py`) returned `{id, username, role}` only, never `permissions` — every
checkbox in that modal (not just the new one) always rendered unchecked regardless of what was
actually saved. Now bulk-fetches `UserPermission` rows and includes a comma-joined
`permissions` string per user.

## CBC report redesign (`src/routes/reports.py`)

### The complaint and the actual cause

CBC reports sometimes overflowed the page. Traced to `_build_test_dict()` always emitting a
*second stacked row* per differential-count parameter with an absolute count — CBC's 5
differential parameters alone produced 10 rows on top of its blood-picture rows, in one
already-narrow 4-column table. **Row count, not column width, was the real driver** — fixing
it required a layout change, not just narrower columns.

### The fix — generic, not CBC-specific

`TestParameterTemplate.category`/`parent_parameter_id` (see Schema changes) let a test opt
into a dual-section report layout: **2+ distinct categories among a test's parameters**
triggers `_render_categorized_test()` instead of the original `_render_generic_test_table()`
(the exact original logic, extracted unchanged — a test with 0 or 1 category, i.e. every test
that predates this feature, renders identically to before). Within a categorized test, each
category independently picks its own sub-layout from its *rows' shape* — does any row carry an
absolute value or a parent link? — never from the category's name string, so this works for
any future 2+-category test without the rendering code ever hardcoding "CBC" anywhere:

- **No table-shape signal** → `_render_bulleted_parameter_section()` — "Blood Picture" style:
  bullet + name : boxed value [H/L flag] | reference range + unit. Only the numeric value
  itself is boxed (a per-cell `BACKGROUND`/`BOX` style command), not the flag.
- **Has a table-shape signal** → `_render_relative_absolute_table()` — "Differential Count"
  style: a 2-row spanned header (`Test | Relative count % (Value, Range) | Absolute count K/uL
  (Value, Range)`), `repeatRows=2` so the header survives a page break, and a root parameter's
  children (matched by `parent_template_id`) print immediately after it, indented via
  `ParagraphStyle(leftIndent=...)` (not manual whitespace, which breaks under Arabic
  reshaping/bidi).

`_absolute_count_row()` (old: built a synthetic second row) became **`_absolute_count_fields()`**
(new: returns extra keys merged into the *same* row via `row.update(...)`). The generic
renderer still expands that back into a second stacked row itself, preserving today's exact
output for every non-categorized test; the categorized renderer uses the flat shape directly.
Both `_build_test_dict()` (saved results) and `build_preview_context()` (unsaved preview) got
the identical reshape, so the print-preview always matches the saved PDF.

All new/changed column widths are fractions of `box_w = PAGE_W - 2*MARGIN` (computed once,
already existed) instead of independent inch literals — applied retroactively to the original
generic table and the comments/interpretation boxes too, so nothing can silently drift out of
the printable area again regardless of page size.

### Data entry

Real CBC parameters were tagged/added to match the user's reference report image:
**Blood Picture** — Hemoglobin (Hb), RBC, Hematocrit (HCT), MCV, MCH, MCHC, RDW, Platelet
Count, WBCs (Leukocytes); **Differential Count** — Neutrophils (parent) → Segmented, Band
(children), Lymphocytes, Monocytes, Eosinophils, Basophils. `display_order` was renumbered to
match the image's visual order (10/20/30/... spacing, cosmetic only — no clinical values on
pre-existing parameters were changed except Neutrophils' relative range, 40–75 → 30–75, to
match the reference image). Absolute-count formulas (`{own_id} / 100 * {WBC_id}`) were wired up
for every differential parameter now that a WBC parameter exists to compute from.

Test Directory's parameter editor (`#parameters-modal` / `renderParameterRows()` in
`script_lab.js`) gained two columns: **Section** (plain text → `category`) and **Parent
Parameter** (a `<select>` → `parent_parameter_id`). The parent dropdown tracks the *array
index* of the chosen row, not a DB id, until save time (`_parentRowIndex`) — mirrors the
existing `{id}`-token two-pass save already used for `relation_formula`/
`absolute_count_formula`, since a newly-added parent row has no real id yet either.
`removeParameterRow()` fixes up every other row's `_parentRowIndex` on delete (decrements
anything pointing past the removed index, nulls out anything pointing *at* it) since those
references are positional.

## New/changed API endpoints (reference)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/visits/pending-approval` | List of visits with `approval_status == 'pending_approval'` — `approve_results` permission required |
| `POST` | `/api/visits/approve` | Approve one/many/all pending visits; returns per-visit messaging payloads — `approve_results` permission required |
| `GET` | `/api/visits/<id>/results-view` | Gained `status`/`approval_status` fields |
| `GET` | `/api/visits`, `/api/upload-report`, `/visits/<id>/results` | `status` can now be `'awaiting_approval'`; `messaging` response objects gained `approval_pending` |
| `POST` | `/api/lab-tests/<id>/parameters`, `PUT /api/parameters/<id>` | Accept `category`, `parent_parameter_id` |
| `GET` | `/api/auth/users` | Now includes each user's `permissions` (previously omitted — see permission section above) |

## Data-clear script (delivered, not run)

The user asked for a way to wipe all data except `users`, `user_permissions`, `lab_config`,
`clinic_config`, `lab_tests`, `test_parameter_templates`, `test_panels`, `test_panel_items` —
to run on their own server, not this one. Built and tested (against a throwaway copy of this
repo's actual `database/app.db`, deleted after) a `sqlite3`-based script:
`PRAGMA foreign_keys = ON` + one transaction, deletes ordered child-before-parent (warehouse →
attendance/HR → activity log → visit/result/transaction line items → legacy clinic
transactions/reservations/patients → visits/transactions/clients), with a mandatory timestamped
backup of the DB file taken first. Handed to the user as a copy-pasteable command, not executed
against this repo's real database — the assumption flagged to them: `service_types` (clinic's
legacy service catalog) was kept, treated as clinic's equivalent of "test lists."

## Gotchas worth remembering

- **`approval_status` vs `status` are two different columns on `PatientVisit`** — don't
  conflate them. `status` is the general delivery-state field several older code paths already
  branch on by exact string; `approval_status` exists solely for the approval workflow. A
  visit can in principle have `status='awaiting_approval'` and `approval_status=NULL` only
  transiently mid-request — by the time either write commits they're set together.
- **Old visits never resurface as pending**: any visit that predates this feature has
  `approval_status IS NULL` forever, and the pending queries only ever match the literal
  string `'pending_approval'` — never inferred from `status` or absence of a value.
  Toggling `require_results_approval` off does not clear an existing pending queue — Check /
  the per-row Approve button stay usable regardless of the setting's current value.
- **A failed WhatsApp/SMS send during approval does not roll `approval_status` back** to
  `'pending_approval'` — approval and delivery success are intentionally decoupled (same as
  the pre-existing single-send flows already treated a failure as separate from status).
  Failures are surfaced in the aggregate toast for manual resend.
- **The live PM2 process (`python-bot-9050`) does not hot-reload** — every backend change in
  this session required `pm2 restart python-bot-9050` to actually take effect for real users.
  Static JS/HTML/JSON changes are served fresh on the next browser request/refresh, no restart
  needed for those alone, but the two were changed together throughout this session so a
  restart was done anyway each time.
- **Real patient data lives in `src/static/reports/*.pdf`, untracked and un-ignored** — these
  are generated report PDFs (real names, e.g. `report_Amira_Youssef_*.pdf`) that `git status`
  shows as untracked but nothing currently excludes via `.gitignore`. Never `git add` these;
  worth adding `src/static/reports/` to `.gitignore` at some point.
