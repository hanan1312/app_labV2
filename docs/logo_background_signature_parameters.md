# Lab Report Customization, Physician/Payment Tracking, and Results Preview Workflow

What was built in this working session, on top of the existing lab report generator
(`src/routes/reports.py`, `src/templates/visit_report.html`). Written as a reference for
picking this work back up later — what changed, where, why, and the gotchas that came out
of it.

## Schema changes

No Alembic in this repo — every column/table below was added via the guarded
per-statement `ALTER TABLE` / restricted `create_all()` pattern in `src/main.py`'s startup
loop (run against both `app.lab_engine` and `app.clinic_engine`), same convention documented
in `CLAUDE.md`.

| Table | New column(s) | Notes |
|---|---|---|
| `lab_config` | `signature_path`, `signature_title` | Pathologist signature image + its caption. `signature_path` follows the exact `logo_path`/`cover_path` convention: either a `data:` base64 URI (uploaded via Settings) or a static-relative path. |
| `test_parameter_templates` | `gender_specific`, `ref_low_male`, `ref_high_male`, `ref_low_female`, `ref_high_female` | Optional per-parameter male/female reference ranges. |
| `visit_tests` | `comment`, `page_number` | Per-test technician comment (shown in the report) and which custom report page that test is assigned to (`NULL` = default layout). |
| `transactions_list` | `amount_paid`, `remaining_fees` | Partial-payment tracking. **Guarded backfill**: every transaction that existed before this feature was, by definition, paid in full — a blind `DEFAULT` would have read as "$0 paid" for every historical row, so `amount_paid` is explicitly backfilled to `final_payment` for any row where it's `NULL`, in the same migration block (same reasoning as the `WarehouseWorkOrder` backfill note in `CLAUDE.md`). `remaining_fees DEFAULT 0` is correct as-is for old rows. |

New tables (via `db.Model.metadata.create_all(bind=engine, tables=[...])`):

- `visit_report_pages` (`src/models/junctions.py`, `VisitReportPage`) — one row per custom
  page a technician defines for a visit's report (`visit_id`, `page_number`, `title`,
  `subtitle`). Presence of any row for a visit switches the report from its default
  single-flow layout to this page-grouped one.
- `test_panels` / `test_panel_items` (`src/models/test_panel.py`) — named bundles of
  `LabTest`s (e.g. "Lipid Profile") for quick-select while booking. Starts empty; no seeded
  defaults.

## Report PDF + public page (`src/routes/reports.py`, `src/templates/visit_report.html`)

The PDF (`generate_visit_report_pdf` → `_render_pdf_from_context`) and the public
`/report/<id>` HTML page are both driven off the same context dict
(`build_report_context`/`build_preview_context`), so every change below updates both
renderers together.

- **Background image**: the Settings "Cover" image (`LabConfig.cover_path` — the same image
  already used as the app's own UI background) is drawn full-page behind the report content,
  via `onFirstPage`/`onLaterPages` canvas callbacks (`_page_decorations`), with an 85%-white
  legibility wash over it. Fit mode is **contain** (`scale = min(...)`) — shrinks to fit
  entirely within the page rather than cropping to fill it. The same contain-fit was applied
  to the app's own UI background (`applyGlobalSettings()` in `script_lab.js`,
  `background-size: contain` instead of `cover`).
- **Pathologist signature**: uploaded in Settings next to the logo/cover blocks, drawn
  bottom-left on every page. Caption text is `signature_title` if set, else falls back to
  `tech_name` → `lab_director` → `"Authorized Signatory"`.
- **Method hidden from the report**: `TestParameterTemplate.method` still exists, is still
  editable in the "Result Parameters" modal, and still shows to the technician during
  results entry — it just no longer renders in the generated report/public page.
- **Gender-specific reference ranges**: `_effective_ref_range(template, gender)` in
  `reports.py` resolves the correct low/high (and display text) against the client's
  `Client.gender` (`"Male"`/`"Female"`) when a parameter has `gender_specific=True`, falling
  back to the generic `ref_low`/`ref_high` otherwise. Used everywhere a range matters:
  results-entry schema, save-time status computation, the read-only results viewer, the
  Statistics tab, and the report itself.
- **High/Low markers**: replaced the old "bold red text for anything abnormal" styling with
  an explicit **red "H"** / **blue "L"** appended next to the value, computed per-row against
  the gender-resolved range. The underlying `TestResult.status` (`normal`/`abnormal`) is
  unchanged and still drives the Interpretation box.
- **Per-visit report page layout** ("Organize Report Layout", results entry toolbar): a
  technician can assign each booked test to a page, and give each page a title/subtitle —
  one-off per visit, not a reusable template. Backed by `GET/POST/DELETE
  /api/visits/<id>/report-layout`. If no `VisitReportPage` rows exist for a visit, the report
  falls back to the original single-flow layout in booking order — zero-impact for any visit
  that never touches this feature.
- **Repeating per-page header**: logo, lab name/subtitle, doctor/tech credentials,
  contact/social lines, the patient info box (now including a **Physician** line — see
  below), and the QR code are all drawn on the canvas inside `_page_decorations` so they
  repeat identically on every page. `SimpleDocTemplate`'s `topMargin` is a fixed `3.4 * inch`
  budget reserved for this (a full measure-then-build pass was avoided — see "Gotchas" below).
- **Barcode moved top-right**: was a flowable at the bottom of the last page; now drawn via
  `renderPDF.draw(...)` in the top-right corner of the repeating header, on every page.
- **Per-page comments**: each `VisitTest.comment` (entered by the technician per booked
  test during results entry) shows in a "Comments" box scoped to *only that page's tests* —
  computed once via `_attach_page_comments()` and consumed by both the PDF and the HTML
  template (`page.comments` in Jinja). Interpretation and the footer note stay global
  (single occurrence after the last page), since only per-test comments were asked to be
  page-scoped.
- **"Physician" label**: the info box's `Referred By:` line was relabeled to `Physician:` —
  same underlying `PatientVisit.referred_by` field (see "Physician name tracking" below), no
  duplicate line.
- **Filename includes the patient's name**: `report_<PatientName>_<visit_id>.pdf`, via a
  small `_safe_filename_part()` sanitizer (strips to `[A-Za-z0-9_]`).

### Non-destructive preview

`POST /api/visits/<id>/results/preview` — same request shape as the real
`POST /api/visits/<id>/results`, but **nothing is persisted**: no `TestResult` rows, no
`VisitTest.comment` writes, no visit status change, no WhatsApp/SMS message. It builds a
parallel context (`build_preview_context`) from the submitted-but-unsaved `results`/
`comments` payload instead of querying the DB, then renders through the exact same
`_render_pdf_from_context()` the real save path uses, and streams the PDF bytes back
(`Content-Type: application/pdf`) — no file is ever written to `static/reports/` for a
preview.

`_group_tests_into_pages()` is the shared page-grouping logic both `build_report_context`
(saved results) and `build_preview_context` (unsaved) call — it takes a `build_test_dict_fn`
closure so the two contexts differ only in *where a test's rows come from*, not in how pages
get assembled.

In `results_entry.js`: "👁️ Preview Report" and "💾 Save & Finalize" sit side by side (both
always available — labeling/order nudges the preview-first workflow rather than a hard-gated
state machine). Saving a report layout in the Organize modal automatically re-triggers a
preview afterward, so the new layout is reflected immediately.

## Test panels (`src/models/test_panel.py`)

Purely a booking-time UI convenience — a panel's member tests are just regular `VisitTest`
rows once booked, indistinguishable from having been checked individually. Managed from
Test List → "🗂 Manage Panels" (`GET/POST /api/panels`, `PUT/DELETE /api/panels/<id>`).
Surfaces as quick-select chips in the "Book Tests" modal (`applyPanelQuickSelect()`) —
clicking a chip toggle-checks all its member tests; the technician can still adjust
individual checkboxes afterward. Starts empty, no seeded defaults.

## Physician name tracking

Rather than add a new column, `PatientVisit.referred_by` (already existed, default
`'Self'`, but was dead — nothing ever set it) was repurposed as the physician name. Captured
in the "Book Tests" modal with datalist autocomplete (`GET /api/physicians`, distinct
non-`'Self'` values), filterable on the Dashboard visits table and the Statistics tab, and
now labeled `Physician:` on the report itself.

## Partial payments & unpaid tracking

- **At checkout** (`#payment-modal`): "Total Due" (read-only, discount-adjusted) is joined
  by a new editable "Amount Paid" input (defaults to the full due amount) and a derived,
  read-only "Remaining Fees" line. `remaining_fees` is **always computed server-side**
  (`save_transaction()` in `main.py`) — the client-sent amount is never trusted for the
  stored remaining balance, only for what was tendered.
- **Transaction History**: a "🚩 Show Unpaid Only" filter (`?unpaid_only=true` on
  `GET /api/transactions`), a "Total Remaining to Collect" summary sourced from a
  `SUM(remaining_fees)` aggregate computed across *all* matching rows before pagination (not
  just the current page), and the "Final Paid" column split into "Paid" / "Remaining" with a
  red flag badge (`🚩 {amount} EGP owed`) on outstanding rows.
- **Complete Payment**: `PUT /api/transactions/<id>/payment` lets staff settle an
  outstanding balance later — in full or in part. `amount_paid` is clamped to
  `final_payment` (can't overpay past the total due) and `remaining_fees` is recomputed from
  that, same as at booking time. Once `remaining_fees` hits 0 the red flag disappears and the
  row shows "Fully Paid" — no separate "settled" flag, it's purely derived from the balance.
- **Receipt modal**: shows a "Remaining" line only when a balance was left (fully-paid
  receipts look exactly as before).

## Bug fix: Dashboard KPI counters not refreshing

`refreshAfterResultsEntry()` (called via `window.opener` from the results-entry popup after
a save) had `updateDashboard()` (the sole writer of the `#count-*` KPI badges) and
`renderDashboardTable()` (the drill-down table) as **mutually exclusive** branches. Since the
KPI badges stay visible above the drill-down table at all times, this meant entering results
from *inside* a drill-down (e.g. "Collected/Waiting for Results") refreshed the table but
left the badge counts stale until a full reload. Fixed by calling both whenever the
Dashboard tab is active, independent of drill-down state.

## New/changed API endpoints (reference)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/visits/<id>/results/preview` | Non-destructive report preview |
| `GET/POST/DELETE` | `/api/visits/<id>/report-layout` | Per-visit custom page layout |
| `GET/POST` | `/api/panels`, `PUT/DELETE /api/panels/<id>` | Test panel CRUD |
| `GET` | `/api/physicians` | Distinct physician names for autocomplete |
| `PUT` | `/api/transactions/<id>/payment` | Record an additional payment against a transaction |
| `GET` | `/api/visits`, `/api/statistics/test-results`, `/api/transactions` | Gained `physician`/`unpaid_only` filter params and corresponding response fields (`physician_name`, `amount_paid`, `remaining_fees`, `total_remaining`) |

## Gotchas worth remembering

- **Fixed header budget, not measured**: the repeating PDF header uses a flat
  `topMargin = 3.4 * inch` rather than measuring the actual header content height first —
  avoids a chicken-and-egg problem (`SimpleDocTemplate` needs `topMargin` before any canvas
  drawing happens). Sized against a realistic branding-text budget; unusually long doctor/tech
  credential lines or a long lab address could in theory overflow into the table area. Not
  observed in practice, but worth a look if the header ever looks cramped in production.
- **`referred_by` is now load-bearing**: it used to be silently dead (nothing set it). Any
  future feature that assumed it was always `'Self'` needs re-checking.
- **Preview writes no file**: unlike the real save (which writes to `static/reports/` and
  registers via `add_visit_reports()`), preview PDFs only ever exist as an in-memory response
  — nothing to clean up, but also nothing to link back to later.
- **Cover-fit → contain-fit** applies to *both* the PDF background and the app's own UI
  background (they intentionally share the same source image and were changed together).
