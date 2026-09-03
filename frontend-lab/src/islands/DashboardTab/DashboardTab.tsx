import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import VisitsTable, { type VisitRow } from './VisitsTable';

interface ClientRow {
  id: number;
  first_name: string;
  last_name: string;
  phone?: string;
  created_at?: string;
}

interface PagedVisits {
  items: VisitRow[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
}

interface TestSummaryRow {
  id: number;
  name: string;
  pending: number;
  collected: number;
  total: number;
}

type ViewType = 'default' | 'total' | 'pending' | 'finished' | 'tests';

const EMPTY_PAGED: PagedVisits = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
const COLLECTED_LIKE = new Set(['collected', 'partially_delivered', 'awaiting_approval', 'results_delivered_by_link']);

// Port of isDateInRange() (script_lab.js:171-186), used by the 'total' drill-down's date
// filter — kept as its own helper (rather than reusing it for 'tests' too) because the
// vanilla 'tests' branch does its own simpler inline date-string comparison instead; see
// testsRows below.
function isDateInRange(targetDateStr: string | undefined, from: string, to: string): boolean {
  if (!targetDateStr) return false;
  const targetDate = targetDateStr.includes('T') ? targetDateStr.split('T')[0] : targetDateStr.split(' ')[0];
  if (from && targetDate < from) return false;
  if (to && targetDate > to) return false;
  return true;
}

// Reads the app's own theme tokens, same as AttendanceDrillDownModal's TrendChart — matches
// the vanilla updateDashboard()'s dashboardTestDemandChart bar chart.
function DemandChart({ data }: { data: [string, number][] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.Chart === 'undefined') return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const style = getComputedStyle(document.documentElement);
    const muted = style.getPropertyValue('--muted').trim() || '#8aa6b8';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartRef.current = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map((d) => d[0]),
        datasets: [
          {
            label: 'Times Demanded',
            data: data.map((d) => d[1]),
            backgroundColor: 'rgba(92, 189, 185, 0.8)',
            borderColor: '#5cbdb9',
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { precision: 0, color: muted } },
          x: { grid: { display: false }, ticks: { color: muted } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  return <canvas ref={canvasRef} />;
}

export default function DashboardTab() {
  const { t } = useTranslations();

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [allVisits, setAllVisits] = useState<VisitRow[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const [view, setView] = useState<ViewType>('default');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '', status: '', physician: '', unfinishedOnly: false });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pagedVisits, setPagedVisits] = useState<PagedVisits>(EMPTY_PAGED);

  // Full clients+visits fetch — needed for the default view's KPI counts/chart/latest-clients
  // list, and the 'total'/'tests' drill-downs (still client-side aggregated, matching
  // script_lab.js's updateDashboard()/renderDashboardTable() exactly). 'pending'/'finished'
  // don't need this — they're server-paginated below, same as the vanilla version already was.
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiFetch('/api/clients'), apiFetch('/api/visits')])
      .then(async ([clientsRes, visitsRes]) => {
        if (cancelled) return;
        if (clientsRes.ok) setClients(await clientsRes.json());
        if (visitsRes.ok) setAllVisits(await visitsRes.json());
      })
      .catch((err) => console.error('Failed to load dashboard data:', err));
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  useEffect(() => {
    if (view !== 'pending' && view !== 'finished') return;
    const status = filters.unfinishedOnly ? 'partially_delivered' : filters.status || (view === 'pending' ? 'pending' : 'collected');
    const params = new URLSearchParams({ page: String(page), per_page: '100', status });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.physician) params.set('physician', filters.physician);

    let cancelled = false;
    apiFetch(`/api/visits?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedVisits>) : null))
      .then((data) => {
        if (!cancelled && data) setPagedVisits(data);
      })
      .catch((err) => console.error('Failed to load dashboard table:', err));
    return () => {
      cancelled = true;
    };
  }, [view, page, filters, refreshTick]);

  // Re-fetch on returning to the tab — replicates showTab()'s now-removed
  // `case 'dashboard': resetDashboardView(); updateDashboard(); break;` (same self-attached
  // nav-tab click listener pattern as StatisticsTab/ActivityLogTab) — and on the
  // 'lab:refresh-dashboard' event dispatched by refreshVisibleTables() whenever something
  // elsewhere in the app (booking, uploads, results entry, bulk actions) could have changed
  // visit/client data, replicating that function's old direct updateDashboard()/
  // renderDashboardTable() calls (same bridge already used for Statistics — see
  // refreshVisibleTables() in script_lab.js).
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="dashboard"]');
    const onTabClick = () => {
      setView('default');
      setPage(1);
      setSelected(new Set());
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-dashboard', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-dashboard', onExternalRefresh);
    };
  }, []);

  // A filter/page/view change always invalidates whatever was checked — buildAdminTableHTML
  // rebuilt fresh (always-unchecked) checkboxes on every render too, so nothing carried over.
  useEffect(() => {
    setSelected(new Set());
  }, [view, page, filters]);

  const stats = useMemo(() => {
    const clientsWithVisits = new Set(allVisits.map((v) => v.patient_id));
    const unbookedCount = clients.filter((c) => !clientsWithVisits.has(c.id)).length;
    return {
      total: allVisits.length + unbookedCount,
      pending: allVisits.filter((v) => v.status === 'pending').length,
      finished: allVisits.filter((v) => v.status === 'collected').length,
      uniqueTests: new Set(allVisits.flatMap((v) => v.tests || [])).size,
    };
  }, [clients, allVisits]);

  const latestClients = useMemo(
    () =>
      [...clients]
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
        .slice(0, 5),
    [clients]
  );

  const topTests = useMemo(() => {
    const counts: Record<string, number> = {};
    allVisits.forEach((v) => (v.tests || []).forEach((name) => (counts[name] = (counts[name] || 0) + 1)));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [allVisits]);

  const totalView = useMemo(() => {
    if (view !== 'total') return { pageItems: [] as VisitRow[], totalCount: 0, totalPages: 1, startIndex: 0 };
    const clientsWithVisits = new Set(allVisits.map((v) => v.patient_id));
    const unbooked: VisitRow[] = clients
      .filter((c) => !clientsWithVisits.has(c.id))
      .map((c) => ({
        patient_id: c.id,
        date: c.created_at ? window.formatCairoDateTime(c.created_at) : 'N/A',
        visit_id: `2024${String(c.id).padStart(4, '0')}`,
        patient_name: `${c.first_name} ${c.last_name}`,
        phone: c.phone || 'N/A',
        physician_name: '',
        tests: ['None'],
        status: 'registered',
      }));

    let filtered: VisitRow[] = [...allVisits, ...unbooked];
    if (filters.dateFrom || filters.dateTo) filtered = filtered.filter((v) => isDateInRange(v.date, filters.dateFrom, filters.dateTo));
    if (filters.status) filtered = filtered.filter((v) => v.status === filters.status);
    if (filters.physician) {
      const p = filters.physician.toLowerCase();
      filtered = filtered.filter((v) => (v.physician_name || '').toLowerCase().includes(p));
    }
    if (filters.search) {
      const s = filters.search.toLowerCase();
      filtered = filtered.filter(
        (v) => v.visit_id.toLowerCase().includes(s) || v.patient_name.toLowerCase().includes(s) || (v.phone || '').toLowerCase().includes(s)
      );
    }
    filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const perPage = 100;
    const totalCount = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (safePage - 1) * perPage;
    return { pageItems: filtered.slice(startIndex, startIndex + perPage), totalCount, totalPages, startIndex };
  }, [view, allVisits, clients, filters, page]);

  const testsRows = useMemo(() => {
    if (view !== 'tests') return [] as TestSummaryRow[];
    const summary: Record<string, { total: number; pending: number; collected: number }> = {};
    allVisits.forEach((v) => {
      if (filters.dateFrom || filters.dateTo) {
        if (!v.date) return;
        const rowDate = v.date.split(' ')[0];
        if (filters.dateFrom && rowDate < filters.dateFrom) return;
        if (filters.dateTo && rowDate > filters.dateTo) return;
      }
      (v.tests || []).forEach((name) => {
        if (!summary[name]) summary[name] = { total: 0, pending: 0, collected: 0 };
        summary[name].total++;
        if (v.status === 'pending') summary[name].pending++;
        if (COLLECTED_LIKE.has(v.status)) summary[name].collected++;
      });
    });
    let rows = Object.entries(summary).map(([name, s], i) => ({ id: i + 1, name, ...s }));
    if (filters.search) {
      const s = filters.search.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(s));
    }
    return rows;
  }, [view, allVisits, filters]);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function openDrilldown(type: Exclude<ViewType, 'default'>) {
    setView(type);
    setPage(1);
    setFilters((f) => ({ ...f, search: '' })); // matches showDashboardTable() resetting only #dash-search
  }

  async function handleCollectSample(visitId: string) {
    try {
      const res = await apiFetch(`/api/visits/${encodeURIComponent(visitId)}/collect`, { method: 'PUT' });
      if (!res.ok) throw new Error('Failed to update sample status.');
      window.showAlert(t('alerts.sample_collected', 'Sample marked as collected!'), 'success');
      setRefreshTick((n) => n + 1);
    } catch {
      window.showAlert(t('alerts.sample_db_error', 'Database error while updating sample.'), 'error');
    }
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_visits', 'Delete {count} order(s)/visit(s)? This cannot be undone. Any payment already recorded for them is not affected.', { count: ids.length }))) {
      return;
    }
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/visits/${id}`, { method: 'DELETE' });
        if (res.ok) {
          succeeded++;
        } else {
          const body = await res.json().catch(() => ({}));
          failures.push(`#${id}: ${body.error || res.status}`);
        }
      } catch (err) {
        failures.push(`#${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      window.showAlert(t('alerts.visits_deleted', 'Deleted {count} order(s)/visit(s).', { count: succeeded }), 'success');
    } else if (succeeded === 0) {
      window.showAlert(t('alerts.visits_delete_error', 'Error deleting orders/visits: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(
        t('alerts.visits_delete_partial', 'Deleted {ok}; {failed} failed: {msg}', { ok: succeeded, failed: failures.length, msg: failures.join('; ') }),
        'warn'
      );
    }
    setSelected(new Set());
    setRefreshTick((n) => n + 1);
  }

  function toggleRow(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(ids: number[], checked: boolean) {
    setSelected(checked ? new Set(ids) : new Set());
  }

  const filterInputStyle = {
    width: '100%',
    padding: 8,
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(0,0,0,0.3)',
    color: 'white',
  } as const;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ color: 'var(--text)' }}>{t('dashboard.title', 'Laboratory Dashboard')}</h2>
      </div>

      <div className="dashboard-top-cards">
        <button className="stat-card-btn bg-blue" onClick={() => openDrilldown('total')}>
          <div className="details">
            <h3>{t('dashboard.all_patients', 'All Patients')}</h3>
            <div className="val">{stats.total}</div>
          </div>
          <div className="icon">👥</div>
        </button>
        <button className="stat-card-btn bg-cyan" onClick={() => openDrilldown('pending')}>
          <div className="details">
            <h3>{t('dashboard.samples_waiting', 'Samples Waiting For Collection')}</h3>
            <div className="val">{stats.pending}</div>
          </div>
          <div className="icon">👥</div>
        </button>
        <button className="stat-card-btn bg-orange" onClick={() => openDrilldown('finished')}>
          <div className="details">
            <h3>{t('dashboard.collected_stat', 'Collected')}</h3>
            <div className="val">{stats.finished}</div>
          </div>
          <div className="icon">📈</div>
        </button>
        <button className="stat-card-btn bg-teal" onClick={() => openDrilldown('tests')}>
          <div className="details">
            <h3>{t('dashboard.ordered_tests', 'Ordered Tests')}</h3>
            <div className="val">{stats.uniqueTests}</div>
          </div>
          <div className="icon">💸</div>
        </button>
      </div>

      {view === 'default' ? (
        <div className="bento" style={{ marginTop: 24 }}>
          <div className="card col-6">
            <div className="card-h">
              <h3 style={{ color: 'var(--text)' }}>{t('dashboard.latest_clients', 'Latest Registered Clients')}</h3>
            </div>
            <div className="table-container" style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>{t('table_headers.id', 'ID')}</th>
                    <th>{t('table_headers.name', 'Name')}</th>
                    <th style={{ textAlign: 'right' }}>{t('table_headers.action', 'Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {latestClients.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>
                        {t('alerts.empty_no_clients_registered', 'No clients registered yet.')}
                      </td>
                    </tr>
                  ) : (
                    latestClients.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>2024{String(c.id).padStart(4, '0')}</strong>
                        </td>
                        <td>
                          {c.first_name} {c.last_name}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn"
                            style={{ background: 'var(--teal)', color: '#04121d', padding: '6px 12px', fontSize: 11 }}
                            onClick={() => window.openBookTestModal(c.id)}
                          >
                            {t('alerts.btn_book_test_short', '📋 Book Test')}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div
            className="card col-6"
            style={{ cursor: 'pointer', transition: 'transform 0.2s' }}
            onClick={() => window.showTab('financial-overview')}
          >
            <div className="card-h">
              <h3 style={{ color: 'var(--text)' }}>{t('dashboard.most_demanded_tests', 'Most Demanded Tests')}</h3>
              <span style={{ fontSize: 11, color: 'var(--teal)' }}>{t('dashboard.click_for_financials', 'Click for Financials ➔')}</span>
            </div>
            <div style={{ position: 'relative', height: 220, width: '100%' }}>
              <DemandChart data={topTests} />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20, marginTop: 24 }}>
            <button
              className="btn ghost"
              style={{ height: 38, borderColor: 'var(--teal)', color: 'var(--teal)' }}
              onClick={() => setView('default')}
            >
              ⬅ {t('actions.back', 'Back')}
            </button>

            <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 200 }}>
              <span className="search-icon">⌕</span>
              <input
                type="text"
                placeholder="Search Code, Name, Phone..."
                value={filters.search}
                onChange={(e) => updateFilter({ search: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ width: 130 }}>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('filters.from_date', 'From Date')}
                </label>
                <input type="date" style={filterInputStyle} value={filters.dateFrom} onChange={(e) => updateFilter({ dateFrom: e.target.value })} />
              </div>
              <div style={{ width: 130 }}>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('filters.to_date', 'To Date')}
                </label>
                <input type="date" style={filterInputStyle} value={filters.dateTo} onChange={(e) => updateFilter({ dateTo: e.target.value })} />
              </div>
            </div>

            {view !== 'tests' && (
              <>
                <div style={{ width: 140 }}>
                  <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                    {t('filters.status', 'Status')}
                  </label>
                  <select style={filterInputStyle} value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })}>
                    <option value="">{t('filters.all_statuses', 'All Statuses')}</option>
                    <option value="registered">{t('alerts.status_registered', 'Registered')}</option>
                    <option value="pending">{t('alerts.status_pending_badge', 'Pending')}</option>
                    <option value="collected">{t('status.collected_short', 'Collected')}</option>
                    <option value="awaiting_approval">{t('status.awaiting_approval', 'Waiting for Approval')}</option>
                  </select>
                </div>

                <div style={{ width: 160 }}>
                  <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                    {t('table_headers.physician', 'Physician')}
                  </label>
                  <input
                    type="text"
                    list="physician-datalist"
                    placeholder="Any"
                    style={filterInputStyle}
                    value={filters.physician}
                    onChange={(e) => updateFilter({ physician: e.target.value })}
                  />
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 38,
                    padding: '0 12px',
                    borderRadius: 4,
                    border: '1px solid rgba(255,255,255,0.1)',
                    background: 'rgba(0,0,0,0.2)',
                    color: 'var(--text)',
                    fontSize: 13,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <input type="checkbox" checked={filters.unfinishedOnly} onChange={(e) => updateFilter({ unfinishedOnly: e.target.checked })} />
                  🔴 {t('dashboard.unfinished_reports_only', 'Unfinished Reports Only')}
                </label>
              </>
            )}
          </div>

          {view === 'tests' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                <h3 style={{ margin: 0, color: 'var(--text)' }}>{t('alerts.title_ordered_tests', 'List of Ordered Tests')}</h3>
                <button
                  className="btn ghost"
                  style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={(e) => window.exportTableToExcel(e.currentTarget, 'list_of_ordered_tests_report', '#dashboard-tests-table .table-container')}
                >
                  📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
                </button>
              </div>
              <div id="dashboard-tests-table" className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>{t('alerts.th_hash', '#')}</th>
                      <th>{t('alerts.th_test_name', 'Test Name')}</th>
                      <th>{t('alerts.th_pending_samples', 'Pending Samples')}</th>
                      <th>{t('alerts.th_collected_samples', 'Collected Samples')}</th>
                      <th>{t('alerts.th_total_demanded', 'Total Demanded')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testsRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                          {t('alerts.no_entries_match_filters', 'No entries match your filters.')}
                        </td>
                      </tr>
                    ) : (
                      testsRows.map((row) => (
                        <tr key={row.name}>
                          <td>{row.id}</td>
                          <td>
                            <strong>{row.name}</strong>
                          </td>
                          <td>
                            <span className="pill ghost">{t('alerts.pill_pending_count', '{count} Pending', { count: row.pending })}</span>
                          </td>
                          <td>
                            <span className="pill ok">{t('alerts.pill_collected_count', '{count} Collected', { count: row.collected })}</span>
                          </td>
                          <td>
                            <strong>{row.total}</strong>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : view === 'total' ? (
            <>
              <VisitsTable
                title={t('alerts.title_all_appointments', 'List of All Appointments')}
                rows={totalView.pageItems}
                startIndex={totalView.startIndex}
                clickable
                selected={selected}
                onToggleRow={toggleRow}
                onToggleAll={(checked) => toggleAll(totalView.pageItems.filter((r) => r.id != null).map((r) => r.id as number), checked)}
                onCollectSample={handleCollectSample}
                onRowClick={(id) => window.openVisitResultsModal(id)}
                onBulkDelete={handleBulkDelete}
                exportFilename="list_of_all_appointments_report"
                containerId="dashboard-total-table"
                t={t}
              />
              <PaginationControls state={{ page, total_pages: totalView.totalPages, total: totalView.totalCount }} onPageChange={setPage} />
            </>
          ) : (
            <>
              <VisitsTable
                title={t(view === 'pending' ? 'alerts.title_pending_appointments' : 'alerts.title_finished_appointments_collected', view === 'pending' ? 'List of Pending Appointments' : 'List of Finished (Collected) Appointments')}
                rows={pagedVisits.items}
                startIndex={(pagedVisits.page - 1) * (pagedVisits.per_page || 100)}
                clickable
                selected={selected}
                onToggleRow={toggleRow}
                onToggleAll={(checked) => toggleAll(pagedVisits.items.filter((r) => r.id != null).map((r) => r.id as number), checked)}
                onCollectSample={handleCollectSample}
                onRowClick={(id) => window.openVisitResultsModal(id)}
                onBulkDelete={handleBulkDelete}
                exportFilename={`${view}_appointments_report`}
                containerId="dashboard-visits-table"
                t={t}
              />
              <PaginationControls state={pagedVisits} onPageChange={setPage} />
            </>
          )}
        </>
      )}
    </>
  );
}
