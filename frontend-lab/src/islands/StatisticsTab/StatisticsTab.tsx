import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import { StatusPill } from '../../lib/StatusPill';

interface StatRow {
  date: string;
  patient_name?: string;
  gender?: string;
  physician_name?: string;
  test_name?: string;
  parameter_name?: string;
  result_value?: string | number;
  unit?: string;
  reference_range?: string;
  status?: string;
}

interface StatsResponse {
  items: StatRow[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
}

const EMPTY: StatsResponse = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };

const dateInputStyle: CSSProperties = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
};

export default function StatisticsTab() {
  const { t } = useTranslations();
  const [filters, setFilters] = useState({
    search: '',
    dateFrom: '',
    dateTo: '',
    gender: '',
    status: '',
    physician: '',
  });
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [data, setData] = useState<StatsResponse>(EMPTY);

  // Single fetch path — mirrors fetchStatisticsPage() (script_lab.js:4126-4153). Re-runs
  // whenever a filter changes, the page changes, or refreshTick is bumped by one of the two
  // external triggers below (tab click / a write elsewhere in the app while this tab is open).
  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100' });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.gender) params.set('gender', filters.gender);
    if (filters.status) params.set('status', filters.status);
    if (filters.physician) params.set('physician', filters.physician);

    let cancelled = false;
    apiFetch(`/api/statistics/test-results?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<StatsResponse>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load statistics:', err));
    return () => {
      cancelled = true;
    };
  }, [filters, page, refreshTick]);

  // Replicates the 'statistics' case in showTab()'s switch (script_lab.js's now-removed
  // `case 'statistics': loadStatistics(); break;`) by listening on the same sidebar button
  // directly, the same way i18n.ts listens on #language-selector.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="statistics"]');
    const onClick = () => {
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    tabButton?.addEventListener('click', onClick);
    return () => tabButton?.removeEventListener('click', onClick);
  }, []);

  // Replicates refreshVisibleTables()'s statistics branch (script_lab.js) — fired after a
  // write elsewhere in the app (e.g. entering results from the separate results_entry.js
  // popup) so an already-open Statistics tab doesn't show stale data.
  useEffect(() => {
    const onExternalRefresh = () => {
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    window.addEventListener('lab:refresh-statistics', onExternalRefresh);
    return () => window.removeEventListener('lab:refresh-statistics', onExternalRefresh);
  }, []);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1); // any filter change goes back to page 1 - matches searchStatistics()
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('stats.title', 'Test Results Statistics')}</h1>
          <p style={{ color: 'var(--muted)' }}>
            {t('stats.subtitle', 'Every parameter result across all visits — filter for analytics and reporting')}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder={t('stats.search_placeholder', 'Search Patient, Test, Parameter...')}
            value={filters.search}
            onChange={(e) => updateFilter({ search: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 140 }}>
            <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
              {t('filters.from_date', 'From Date')}
            </label>
            <input
              type="date"
              style={dateInputStyle}
              value={filters.dateFrom}
              onChange={(e) => updateFilter({ dateFrom: e.target.value })}
            />
          </div>
          <div style={{ width: 140 }}>
            <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
              {t('filters.to_date', 'To Date')}
            </label>
            <input
              type="date"
              style={dateInputStyle}
              value={filters.dateTo}
              onChange={(e) => updateFilter({ dateTo: e.target.value })}
            />
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--muted)',
              marginBottom: 6,
              display: 'block',
            }}
          >
            {t('filters.gender', 'Gender')}
          </label>
          <select value={filters.gender} onChange={(e) => updateFilter({ gender: e.target.value })}>
            <option value="">{t('filters.all_genders', 'All Genders')}</option>
            <option value="Male">{t('filters.male', 'Male')}</option>
            <option value="Female">{t('filters.female', 'Female')}</option>
          </select>
        </div>
        <div style={{ width: 160 }}>
          <label
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--muted)',
              marginBottom: 6,
              display: 'block',
            }}
          >
            {t('stats.status_label', 'Result Status')}
          </label>
          <select value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })}>
            <option value="">{t('stats.status_all', 'All Statuses')}</option>
            <option value="normal">{t('stats.status_normal', 'Normal')}</option>
            <option value="high">{t('stats.status_high', 'High')}</option>
            <option value="low">{t('stats.status_low', 'Low')}</option>
            <option value="abnormal">{t('stats.status_abnormal', 'Abnormal')}</option>
          </select>
        </div>
        <div style={{ width: 160 }}>
          <label
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--muted)',
              marginBottom: 6,
              display: 'block',
            }}
          >
            Physician
          </label>
          <input
            type="text"
            list="physician-datalist"
            placeholder="Any"
            style={dateInputStyle}
            value={filters.physician}
            onChange={(e) => updateFilter({ physician: e.target.value })}
          />
        </div>
      </div>

      <StatisticsResults data={data} t={t} onPageChange={setPage} />
    </>
  );
}

function StatisticsResults({
  data,
  t,
  onPageChange,
}: {
  data: StatsResponse;
  t: (path: string, fallback: string) => string;
  onPageChange: (page: number) => void;
}) {
  if (!data.items.length) {
    return (
      <div className="table-container">
        <table style={{ width: '100%' }}>
          <tbody>
            <tr>
              <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                No results match your filters.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  const startIndex = (data.page - 1) * (data.per_page || 100);

  return (
    <div id="statistics-list">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
        <h3 style={{ margin: 0, color: 'var(--text)' }}>{t('stats.title', 'Test Results Statistics')}</h3>
        <button
          className="btn ghost"
          style={{
            borderColor: 'var(--ok)',
            color: 'var(--ok)',
            padding: '6px 12px',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
          onClick={(e) => window.exportTableToExcel(e.currentTarget, 'statistics_report', '#statistics-table-container')}
        >
          📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
        </button>
      </div>
      <div id="statistics-table-container" className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Patient</th>
              <th>Gender</th>
              <th>Physician</th>
              <th>Test</th>
              <th>Parameter</th>
              <th>Result</th>
              <th>Ref. Range</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r, index) => (
              <tr key={startIndex + index}>
                <td>{startIndex + index + 1}</td>
                <td style={{ color: 'var(--muted)' }}>{window.formatCairoDateTime(r.date, false)}</td>
                <td>{r.patient_name || 'N/A'}</td>
                <td>
                  <span className="pill ghost">{r.gender || '-'}</span>
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {r.physician_name && r.physician_name !== 'Self' ? r.physician_name : '-'}
                </td>
                <td>{r.test_name || ''}</td>
                <td>{r.parameter_name || ''}</td>
                <td>
                  {r.result_value || ''} {r.unit || ''}
                </td>
                <td style={{ color: 'var(--muted)' }}>{r.reference_range || '-'}</td>
                <td>
                  <StatusPill status={r.status} t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationControls state={data} onPageChange={onPageChange} />
    </div>
  );
}
