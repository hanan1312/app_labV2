import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import VisitsTable, { type VisitRow } from '../DashboardTab/VisitsTable';

interface PagedVisits {
  items: VisitRow[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
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

export default function PendingSamplesTab() {
  const { t } = useTranslations();

  const [data, setData] = useState<PagedVisits>(EMPTY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100', status: 'pending' });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);

    let cancelled = false;
    apiFetch(`/api/visits?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedVisits>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load pending samples:', err));
    return () => {
      cancelled = true;
    };
  }, [page, filters, refreshTick]);

  useEffect(() => {
    setSelected(new Set());
  }, [page, filters]);

  // Same self-attached nav-tab click / lab:refresh-* CustomEvent bridge as Dashboard/
  // Clients/Statistics — refreshVisibleTables() dispatches the latter whenever something
  // elsewhere (booking, collecting, bulk actions) could have changed this list.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="pending-samples"]');
    const onTabClick = () => {
      setFilters({ search: '', dateFrom: '', dateTo: '' }); // matches loadPendingSamples() clearing filters on entry
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-pending-samples', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-pending-samples', onExternalRefresh);
    };
  }, []);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  async function collectOne(visitId: string) {
    const res = await apiFetch(`/api/visits/${encodeURIComponent(visitId)}/collect`, { method: 'PUT' });
    return res.ok;
  }

  async function handleCollectSample(visitId: string) {
    try {
      if (!(await collectOne(visitId))) throw new Error('Failed to update sample status.');
      window.showAlert(t('alerts.sample_collected', 'Sample marked as collected!'), 'success');
      setRefreshTick((n) => n + 1);
    } catch {
      window.showAlert(t('alerts.sample_db_error', 'Database error while updating sample.'), 'error');
    }
  }

  async function handleFinishSelected(ids: number[]) {
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_mark_finished', 'Mark {count} sample(s) as finished?', { count: ids.length }))) return;
    const visitIds = data.items.filter((v) => v.id != null && ids.includes(v.id)).map((v) => v.visit_id);
    try {
      for (const visitId of visitIds) {
        await collectOne(visitId);
      }
      window.showAlert(t('alerts.samples_finished', 'Samples marked as finished!'), 'success');
    } catch {
      window.showAlert(t('alerts.samples_update_error', 'Error updating samples.'), 'error');
    }
    setSelected(new Set());
    setRefreshTick((n) => n + 1);
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

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(data.items.filter((r) => r.id != null).map((r) => r.id as number)) : new Set());
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('pending.title', 'Pending Samples')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('pending.subtitle', 'Clients waiting for sample collection')}</p>
        </div>
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
      </div>

      <VisitsTable
        title={t('alerts.title_pending_appointments', 'List of Pending Appointments')}
        rows={data.items}
        startIndex={(data.page - 1) * (data.per_page || 100)}
        clickable={false}
        selected={selected}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        onCollectSample={handleCollectSample}
        onRowClick={() => {}}
        onBulkDelete={handleBulkDelete}
        // Not wrapped in t()/data-i18n in the original (#finish-samples-btn's literal
        // textContent) — kept literal here for a faithful port.
        extraBulkAction={{ label: '✅ Finish Selected', onClick: handleFinishSelected }}
        exportFilename="pending_samples_report"
        containerId="pending-samples-table"
        t={t}
      />
      <PaginationControls state={data} onPageChange={setPage} />
    </>
  );
}
