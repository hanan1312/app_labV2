import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { useCurrentUser } from '../../lib/useCurrentUser';
import { PaginationControls } from '../../lib/PaginationControls';

interface VisitRow {
  id: number;
  visit_id: string;
  patient_id: number;
  patient_name: string;
  date: string;
  tests: string[];
  phone?: string;
  status: string;
}

interface PagedVisits {
  items: VisitRow[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
}

interface ApprovalRow {
  id: number;
  patient_name: string;
  phone?: string;
  date: string;
  tests?: string[];
}

const EMPTY: PagedVisits = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };

const filterInputStyle = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
} as const;

export default function TestResultsTab() {
  const { t } = useTranslations();
  const { user, isAdmin } = useCurrentUser();
  const canApprove = isAdmin || (user?.permissions.includes('approve_results') ?? false);

  const [data, setData] = useState<PagedVisits>(EMPTY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '', gender: '', status: 'results_delivered_by_link' });
  const [refreshTick, setRefreshTick] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [approvalItems, setApprovalItems] = useState<ApprovalRow[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100', status: filters.status || 'results_delivered_by_link' });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.gender) params.set('gender', filters.gender);

    let cancelled = false;
    apiFetch(`/api/visits?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedVisits>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load test results:', err));
    return () => {
      cancelled = true;
    };
  }, [page, filters, refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-test-results CustomEvent bridge as
  // Dashboard/Clients/Pending Samples/Tech Screen — the latter fires from
  // refreshVisibleTables() (script_lab.js), including after approveVisitsAndNotify()'s own
  // loadInitialData() call, so an already-open list picks up a just-approved visit's new status.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="test-results"]');
    const onTabClick = () => {
      setFilters({ search: '', dateFrom: '', dateTo: '', gender: '', status: 'results_delivered_by_link' }); // matches loadTestResults() clearing filters on entry
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-test-results', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-test-results', onExternalRefresh);
    };
  }, []);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  async function openApprovalModal() {
    setModalOpen(true);
    setModalLoading(true);
    setSelectAll(false);
    setChecked(new Set());
    try {
      const res = await apiFetch('/api/visits/pending-approval');
      const items = res.ok ? ((await res.json()) as ApprovalRow[]) : [];
      setApprovalItems(items);
    } catch (err) {
      console.error('Failed to load pending approvals:', err);
      setApprovalItems([]);
    } finally {
      setModalLoading(false);
    }
  }

  function toggleRow(id: number, isChecked: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (isChecked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleApproveSelected() {
    if (!selectAll && checked.size === 0) {
      window.showAlert(t('alerts.select_at_least_one_test', 'Please select at least one test.'), 'warn');
      return;
    }
    setApproving(true);
    try {
      // "Select all" is sent as an explicit server-side flag, not the checked-id list, so it
      // always means "every visit pending right now" — never limited to what happened to be
      // fetched into this modal (matches the vanilla approveSelectedResults()).
      const body = selectAll ? { approve_all: true } : { visit_ids: [...checked] };
      const ok = await window.approveVisitsAndNotify(body);
      if (ok) setModalOpen(false);
    } finally {
      setApproving(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('results.title', 'Delivered Results History')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('results.subtitle', 'Archive of all patients with finished and uploaded PDF reports')}</p>
        </div>
        {canApprove && (
          <button type="button" className="btn" onClick={openApprovalModal}>
            ✅ <span>{t('results.check_approvals', 'Check Pending Approvals')}</span>
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder={t('dashboard.search_placeholder', 'Search Patient ID, Name, Phone...')}
            value={filters.search}
            onChange={(e) => updateFilter({ search: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 140 }}>
            <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
              {t('filters.from_date', 'From Date')}
            </label>
            <input type="date" style={filterInputStyle} value={filters.dateFrom} onChange={(e) => updateFilter({ dateFrom: e.target.value })} />
          </div>
          <div style={{ width: 140 }}>
            <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
              {t('filters.to_date', 'To Date')}
            </label>
            <input type="date" style={filterInputStyle} value={filters.dateTo} onChange={(e) => updateFilter({ dateTo: e.target.value })} />
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            {t('filters.gender', 'Gender')}
          </label>
          <select style={filterInputStyle} value={filters.gender} onChange={(e) => updateFilter({ gender: e.target.value })}>
            <option value="">{t('filters.all_genders', 'All Genders')}</option>
            <option value="Male">{t('filters.male', 'Male')}</option>
            <option value="Female">{t('filters.female', 'Female')}</option>
          </select>
        </div>
        <div style={{ width: 170 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            {t('filters.status', 'Status')}
          </label>
          <select style={filterInputStyle} value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })}>
            <option value="results_delivered_by_link">{t('status.delivered', 'Delivered')}</option>
            <option value="awaiting_approval">{t('status.awaiting_approval', 'Waiting for Approval')}</option>
          </select>
        </div>
      </div>

      {data.items.length === 0 ? (
        <div className="table-container">
          <table style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No results match your filters.</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Patient ID</th>
                  <th>Date &amp; Time</th>
                  <th>Patient Name</th>
                  <th>Phone Number</th>
                  <th>Tests Included</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((v, index) => (
                  <tr
                    key={v.id}
                    onClick={(e) => {
                      if (!(e.target as HTMLElement).closest('.no-row-click')) window.openVisitResultsModal(v.id);
                    }}
                    style={{ cursor: 'pointer' }}
                    title={t('alerts.view_results_title', 'View results')}
                  >
                    <td>{(data.page - 1) * (data.per_page || 100) + index + 1}</td>
                    <td>
                      <strong>2024{String(v.patient_id).padStart(4, '0')}</strong>
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{window.formatCairoDateTime(v.date, false)}</td>
                    <td>{v.patient_name}</td>
                    <td style={{ color: 'var(--muted)' }}>{v.phone || 'N/A'}</td>
                    <td>{v.tests.join(', ')}</td>
                    <td>
                      {v.status === 'awaiting_approval' ? (
                        <span className="pill warn">{t('alerts.status_awaiting_approval', 'Waiting for Approval')}</span>
                      ) : (
                        <span className="pill ok">{t('alerts.status_delivered', 'Delivered')}</span>
                      )}
                    </td>
                    <td className="no-row-click" style={{ textAlign: 'right' }}>
                      <button className="btn ghost" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }} onClick={() => window.printPDFReport(v.visit_id)}>
                        🖨️ Print PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls state={data} onPageChange={setPage} />
        </>
      )}

      {modalOpen && (
        <div id="test-results-approval-modal" className="modal" style={{ display: 'block' }}>
          <div className="modal-content glass-panel" style={{ maxWidth: 700 }}>
            <span className="close" onClick={() => setModalOpen(false)}>
              &times;
            </span>
            <h2 style={{ marginBottom: 10, color: 'var(--text)' }}>{t('results.pending_approval_title', 'Results Pending Approval')}</h2>
            <p style={{ marginBottom: 15, color: 'var(--muted)' }}>
              {t('results.pending_approval_subtitle', 'Select the results to approve — approving sends the results-ready message to the patient.')}
            </p>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={(e) => setSelectAll(e.target.checked)}
                  style={{ marginRight: 10, width: 'auto' }}
                />
                <span>{t('actions.select_all', 'Select All')}</span>
              </label>
            </div>

            <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 20 }}>
              {modalLoading ? (
                <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>{t('alerts.loading', 'Loading...')}</p>
              ) : approvalItems.length === 0 ? (
                <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>{t('alerts.no_pending_approval', 'No results are waiting for approval.')}</p>
              ) : (
                approvalItems.map((v) => (
                  <label
                    key={v.id}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', color: 'var(--text)', padding: 10, borderBottom: '1px solid var(--border)' }}
                  >
                    <input
                      type="checkbox"
                      checked={selectAll || checked.has(v.id)}
                      onChange={(e) => toggleRow(v.id, e.target.checked)}
                      style={{ marginTop: 3, width: 'auto' }}
                    />
                    <span style={{ flex: 1 }}>
                      <strong>{v.patient_name}</strong> <span style={{ color: 'var(--muted)', fontSize: 12 }}>({v.phone || 'No phone'})</span>
                      <br />
                      <small style={{ color: 'var(--muted)' }}>
                        {window.formatCairoDateTime(v.date, false)} — {(v.tests || []).join(', ')}
                      </small>
                    </span>
                  </label>
                ))
              )}
            </div>

            <div style={{ textAlign: 'right' }}>
              <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>
                {t('actions.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }}
                onClick={handleApproveSelected}
                disabled={approving}
              >
                {t('results.approve_selected', 'Approve & Send Selected')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
