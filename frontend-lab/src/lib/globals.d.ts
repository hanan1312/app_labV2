// Ambient types for still-vanilla script_lab.js globals that React islands call directly
// instead of reimplementing — both scripts share one window/document, so these plain
// function declarations (classic <script>, not a module) are reachable as window.*.
export {};

declare global {
  interface Window {
    // script_lab.js:159 — pure date formatter, no DOM dependency.
    formatCairoDateTime: (value: string | null | undefined, includeSeconds?: boolean) => string;
    // script_lab.js:7922 — reads real DOM <table> markup (React renders actual <table>
    // elements, so this works unchanged); containerSelector picks the table explicitly
    // rather than relying on the button's DOM position.
    exportTableToExcel: (btnElement: HTMLElement, filename: string, containerSelector?: string) => void;
    // script_lab.js:3233-3251 — hand-built toast, appended to #alert-container. The
    // implementation only ever distinguishes `type === 'success'` from everything else
    // (styled identically regardless of 'error'/'warn'/'danger'/etc), so `type` is loosely
    // typed as a plain string rather than a strict union.
    showAlert: (message: string, type?: string) => void;
    // script_lab.js:301-312 — dynamic-string i18n helper (translations[lang].alerts[key]),
    // distinct from useTranslations()'s own `t`, which looks up the whole nested tree. Used
    // only where React code calls a vanilla global directly (e.g. apiFetch.ts's offline path)
    // and isn't in a position to use the hook.
    t: (key: string, fallback: string, vars?: Record<string, string | number>) => string;
    // script_lab.js:73-94 — queues a failed write into the IndexedDB `sync-outbox` store that
    // window.addEventListener('online', syncOfflineData) already replays on reconnect.
    saveToOfflineQueue: (url: string, method: string, payload: unknown) => Promise<void>;
    // script_lab.js:4416-4433 — still runs on its own DOMContentLoaded listener and stays the
    // one thing populating the vanilla-scope `availableTests` array that the not-yet-migrated
    // Book Test modal and Excel import/export engine read directly (Test Panels and the
    // Parameters modal are both migrated now and fetch their own copy instead).
    // TestListTab calls this after its own writes so those features don't see stale data.
    fetchLabTests: () => Promise<void>;
    // script_lab.js:4386 — still runs on its own DOMContentLoaded listener; kept alive purely
    // to keep populating `availablePanels`, which the still-vanilla Book Test modal's
    // applyPanelQuickSelect() reads directly. TestListTab calls this after its own panel
    // writes, same reason it calls window.fetchLabTests().
    fetchPanels: () => Promise<void>;
    // script_lab.js:520 — trimmed of its old renderHRTable() call, but still refetches
    // `employees` (read by the not-yet-migrated attendance drill-down modal) and refreshes
    // the deferred Attendance Policy / Attendance Report panels still living in vanilla HTML
    // inside #hr-management. HREmployeesTab calls this after its own writes for the same
    // reason TestListTab calls window.fetchLabTests().
    fetchHRData: () => Promise<void>;
    // script_lab.js — pure UTC-based date-range math (today/week/month/year). Still used by
    // both the Attendance Report and AttendanceDrillDownModal (each computes its own range
    // independently) — reused here rather than re-implementing the same boundary logic in TS.
    attendancePresetRange: (preset: 'today' | 'week' | 'month' | 'year', refDateStr?: string) => { from: string; to: string };
    // Chart.js, loaded globally via index_lab.html's CDN script (the full auto-registering
    // UMD bundle — no Chart.register() calls anywhere in this codebase). Untyped beyond the
    // constructor/destroy shape actually used (AttendanceDrillDownModal's trend line) and the
    // two `defaults` fields FinancialOverviewTab sets once on mount (matching the vanilla
    // renderFinancialCharts()'s own global Chart.defaults.color/font.family mutation) — the
    // vanilla code that built this same config object had no type-checking either.
    Chart: {
      new (ctx: CanvasRenderingContext2D, config: Record<string, unknown>): { destroy: () => void };
      defaults: { color: string; font: { family: string } };
    };
    // script_lab.js:1640 — HR's own dedicated Excel import (employees only, distinct from
    // Test Directory's engine); takes the file input's change event.
    processHRExcelImport: (event: Event) => void;
    // SheetJS, loaded globally via index_lab.html's xlsx.full.min.js CDN script — used
    // directly (not through exportTableToExcel) when exporting a hand-picked subset of rows
    // rather than whatever's currently in a DOM <table>, and by TestListTab's own two-sheet
    // (Tests + Parameters) Excel import/export.
    XLSX: {
      utils: {
        aoa_to_sheet: (data: unknown[][]) => unknown;
        json_to_sheet: (data: Record<string, unknown>[]) => unknown;
        sheet_to_json: (worksheet: unknown) => Record<string, unknown>[];
        book_new: () => unknown;
        book_append_sheet: (workbook: unknown, worksheet: unknown, name: string) => void;
      };
      read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
      writeFile: (workbook: unknown, filename: string) => void;
    };
    // setup_and_run.sh-generated src/static/js/config.js — the backend/WhatsApp-bot ports,
    // never hardcoded (see CLAUDE.md's Frontend section).
    APP_PORTS: { backend: number; node: number };
    // script_lab.js:2720 — opens the shared #patient-history-modal (static markup outside
    // every .tab-content, DOM-mutated directly), still vanilla. ReportsTab's "View Details"
    // calls this instead of porting the modal itself — see globals.d.ts's file header.
    openPatientHistoryModal: (clientId: number) => void;
    // script_lab.js — toggles document.body's light/dark class + persists via
    // POST /api/lab/settings/theme. Cross-cutting (affects every page, not just Settings),
    // stays vanilla; SettingsTab's "Toggle Light/Dark" button calls this directly.
    toggleTheme: () => Promise<void>;
    // script_lab.js — re-applies fetched LabConfig to the sidebar logo/name/subtitle, page
    // background, and body theme class app-wide. Still the one function doing that (it now
    // gracefully no-ops on the settings-form fields it used to also populate, since
    // SettingsTab owns and fetches those itself — see the call site's own comment).
    // SettingsTab calls this after a successful save, same "refresh after my own write"
    // bridge pattern as window.fetchLabTests()/fetchPanels() above.
    applyGlobalSettings: () => Promise<void>;
    // script_lab.js's showTab() — still owns tab navigation (toggles .active on the
    // unmigrated .tab-content wrappers). DashboardTab's demand-chart card uses this to jump
    // to Financial Overview, same cross-tab link the vanilla card's onclick used.
    showTab: (tabName: string) => void;
    // script_lab.js:3310 — opens the shared, still-vanilla Book Test modal (patient picker +
    // live test checkboxes) for a given client id. DashboardTab's latest-clients list and
    // its visit-table drill-downs (registered/collected rows) call this instead of porting
    // the modal itself, same bridge pattern as ReportsTab's window.openPatientHistoryModal.
    openBookTestModal: (clientId: number) => void;
    // script_lab.js:2965 — opens the shared, still-vanilla PDF upload modal for a visit.
    // DashboardTab's drill-down row actions call this rather than porting that modal.
    openUploadModal: (visitId: string, patientId: number, patientName: string) => void;
    // script_lab.js:2745 — opens the shared, still-vanilla visit results modal. DashboardTab's
    // drill-down rows call this on row click (matching buildAdminTableHTML's rowIsClickable
    // rule) instead of porting that modal.
    openVisitResultsModal: (visitId: number) => void;
    // script_lab.js:1147 — loads a client into the (still-vanilla) Add/Edit Patient form and
    // switches to that tab. DashboardTab's drill-down "Edit Patient" action calls this.
    quickEditPatient: (clientId: number) => void;
    // script_lab.js:1404 — sends an already-generated report PDF to the printer (Print.js if
    // present, else a hidden-iframe fallback). DashboardTab's drill-down "Print Report" action
    // calls this instead of reimplementing print delivery.
    printPDFReport: (visitId: string, fileIndex?: number) => void;
    // script_lab.js's main bootstrap fetch — refetches clients/labConfig/testResults/
    // allVisits/transactions in one go and ends with refreshVisibleTables() (which dispatches
    // the lab:refresh-* CustomEvents React islands listen for). AddClientTab calls this after
    // a successful create/update so the still-vanilla consumers of the `clients` global
    // (Excel import's duplicate check, Tech Screen, Pending Samples) don't go stale, the same
    // way the vanilla handleAddClient()/handleBulkDelete() it replaces always did.
    loadInitialData: () => Promise<void>;
    // script_lab.js:5571 — parses an uploaded Patient Excel/CSV file (fuzzy EN/AR header
    // matching, per-row duplicate confirmation) and POSTs each row to /api/clients. Left
    // vanilla rather than ported — self-contained and reads the `clients` global directly for
    // its duplicate check, same boundary as HR's own separate window.processHRExcelImport.
    // ClientsTab's "Import Excel" button triggers the hidden file input this listens on.
    processPatientExcelImport: (event: Event) => void;
    // script_lab.js — shared core for bulk approval (Test Results > Check) and single-visit
    // approval (the still-vanilla Visit Results modal's own "Approve & Send" button): POSTs to
    // /api/visits/approve, sends the results-ready WhatsApp/SMS message for every returned
    // visit with a phone on file, shows one aggregate toast, and refreshes via
    // loadInitialData(). Left vanilla rather than ported — TestResultsTab's own approval modal
    // calls this instead of reimplementing the per-result message-sending loop; returns
    // whether the caller should close its own modal.
    approveVisitsAndNotify: (body: { approve_all?: boolean; visit_ids?: number[] }) => Promise<boolean>;
    // JsBarcode, loaded globally via index_lab.html's CDN script — used directly by
    // WarehouseTab/batchLabel.ts to render a batch's barcode into a canvas (same options the
    // vanilla generateBarcodeImage() used), since batch receipts/labels are the only place in
    // the React port that needs one. Untyped beyond the constructor shape actually used.
    JsBarcode: (element: HTMLCanvasElement, text: string, options?: Record<string, unknown>) => void;
    // script_lab.js — Warehouse's own Excel import (fuzzy EN/AR header + category-keyword
    // matching, per-row duplicate confirmation), left vanilla for the same reason as Patient
    // Excel import: self-contained, reads the `warehouseItems` global directly for its
    // duplicate check. WarehouseTab's "Import Excel" button triggers the hidden file input
    // this listens on.
    processWarehouseExcelImport: (event: Event) => void;
    // script_lab.js — refetches the full (unpaginated) transaction list into the vanilla
    // `allTransactions` global and repopulates the checkout modal's payment-method
    // <datalist>. Left vanilla rather than ported — that datalist is the one remaining vanilla
    // consumer of `allTransactions` (Financial Overview fetches its own copy of
    // /api/transactions now). It also dispatches lab:refresh-financial-overview, so
    // TransactionHistoryTab still calls this after its own writes (Complete Payment, bulk
    // delete) to keep both the checkout datalist and Financial Overview's totals in sync.
    fetchTransactionsData: () => Promise<void>;
    // script_lab.js:774 — the page shell's bell-icon notification dropdown (adds one entry,
    // persisted to localStorage['lab_notifications'], re-renders the badge/list). Cross-cutting
    // and stays vanilla, same boundary as window.showAlert (a one-shot toast) vs. this
    // (a persistent dismissible history) — FinancialOverviewTab calls this for the
    // once-a-day "today beat yesterday" revenue-milestone notice, matching the vanilla
    // calculateFinancials()'s own addNotification() call exactly.
    addNotification: (text: string, type?: string) => void;
  }
}
