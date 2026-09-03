import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import VisitsTable, { type VisitRow } from '../DashboardTab/VisitsTable';

type ViewType = 'pending' | 'finished' | null;

export default function TechScreenTab() {
  const { t } = useTranslations();

  const [allVisits, setAllVisits] = useState<VisitRow[]>([]);
  const [view, setView] = useState<ViewType>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refreshTick, setRefreshTick] = useState(0);

  // Built from the full unfiltered /api/visits list, client-side filtered/paginated — matches
  // the vanilla renderTechTable(), which read the already-loaded allVisits global the same way
  // (unlike Pending Samples, which is server-paginated).
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/visits')
      .then((res) => (res.ok ? (res.json() as Promise<VisitRow[]>) : null))
      .then((json) => {
        if (!cancelled && json) setAllVisits(json);
      })
      .catch((err) => console.error('Failed to load tech screen data:', err));
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-tech-screen CustomEvent bridge as
  // Dashboard/Clients/Pending Samples.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="tech-screen"]');
    const onTabClick = () => setRefreshTick((n) => n + 1);
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-tech-screen', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-tech-screen', onExternalRefresh);
    };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [view, page]);

  const pendingCount = useMemo(() => allVisits.filter((v) => v.status === 'pending').length, [allVisits]);
  const finishedCount = useMemo(() => allVisits.filter((v) => v.status === 'collected').length, [allVisits]);

  const filtered = useMemo(() => {
    if (!view) return [];
    const rows = allVisits.filter((v) => v.status === (view === 'pending' ? 'pending' : 'collected'));
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return rows;
  }, [allVisits, view]);

  const perPage = 20;
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * perPage;
  const pageItems = filtered.slice(startIndex, startIndex + perPage);

  function openView(type: 'pending' | 'finished') {
    setView(type);
    setPage(1);
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

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(pageItems.filter((r) => r.id != null).map((r) => r.id as number)) : new Set());
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ color: 'var(--text)' }}>{t('tech_screen.title', 'Laboratory Technical Dashboard')}</h2>
      </div>

      <div className="dashboard-top-cards" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 24 }}>
        <button className="stat-card-btn bg-cyan" onClick={() => openView('pending')}>
          <div className="details">
            <h3>{t('tech_screen.pending_card', 'Samples Waiting For Collection')}</h3>
            <div className="val">{pendingCount}</div>
          </div>
          <div className="icon">⏳</div>
        </button>

        <button className="stat-card-btn bg-orange" onClick={() => openView('finished')}>
          <div className="details">
            <h3 style={{ whiteSpace: 'normal' }}>{t('tech_screen.finished_card', 'Collected (Waiting for Reports)')}</h3>
            <div className="val">{finishedCount}</div>
          </div>
          <div className="icon">🧪</div>
        </button>
      </div>

      {view && (
        <>
          <VisitsTable
            title={view === 'pending' ? t('tech_screen.pending_card', 'Samples Waiting For Collection') : t('tech_screen.finished_card', 'Collected (Waiting for Reports)')}
            rows={pageItems}
            startIndex={startIndex}
            clickable={false}
            selected={selected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            onCollectSample={handleCollectSample}
            onRowClick={() => {}}
            onBulkDelete={handleBulkDelete}
            exportFilename={`tech_screen_${view}_report`}
            containerId="tech-screen-table"
            t={t}
          />
          <PaginationControls state={{ page: safePage, total_pages: totalPages, total: totalCount }} onPageChange={setPage} />
        </>
      )}
    </>
  );
}
