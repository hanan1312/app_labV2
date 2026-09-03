import { useEffect, useState, type ChangeEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';

interface ClientRow {
  id: number;
  first_name: string;
  last_name: string;
  gender: string;
  phone?: string;
  created_at?: string;
  test_type?: string;
  sample_status?: string;
}

interface PagedClients {
  items: ClientRow[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
}

const EMPTY: PagedClients = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };

const filterInputStyle = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
} as const;

function statusBadge(c: ClientRow, t: (path: string, fallback: string) => string): { pillClass: string; text: string } {
  if (c.test_type && c.test_type.trim() !== '') {
    if (c.sample_status === 'pending') return { pillClass: 'danger', text: t('alerts.status_pending_badge', 'Pending') };
    if (c.sample_status === 'collected') return { pillClass: 'ok', text: t('alerts.status_sample_collected', 'Sample Collected') };
  }
  return { pillClass: 'info', text: t('alerts.status_registered', 'Registered') };
}

export default function ClientsTab() {
  const { t } = useTranslations();

  const [data, setData] = useState<PagedClients>(EMPTY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '', gender: '', status: '' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refreshTick, setRefreshTick] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100' });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.gender) params.set('gender', filters.gender);
    if (filters.status) params.set('status', filters.status);

    let cancelled = false;
    apiFetch(`/api/clients?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedClients>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load clients:', err));
    return () => {
      cancelled = true;
    };
  }, [page, filters, refreshTick]);

  useEffect(() => {
    setSelected(new Set());
  }, [page, filters]);

  // Same self-attached nav-tab click / lab:refresh-clients CustomEvent bridge pattern as
  // Statistics/ActivityLog/Dashboard — refreshVisibleTables() dispatches the latter whenever
  // something elsewhere (add/edit/delete a client, Excel import) could have changed this list.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="clients"]');
    const onTabClick = () => {
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-clients', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-clients', onExternalRefresh);
    };
  }, []);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function handleAddNewPatient() {
    window.dispatchEvent(new CustomEvent('lab:edit-client', { detail: { clientId: null } }));
    window.showTab('add-client');
  }

  function handleImportChange(e: ChangeEvent<HTMLInputElement>) {
    window.processPatientExcelImport(e.nativeEvent);
    e.target.value = '';
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
    setSelected(checked ? new Set(data.items.map((c) => c.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_clients', 'Delete {count} client(s)? This cannot be undone.', { count: ids.length }))) {
      return;
    }
    setDeleting(true);
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
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
      window.showAlert(t('alerts.clients_deleted', 'Clients deleted successfully!'), 'success');
    } else if (succeeded === 0) {
      window.showAlert(t('alerts.clients_delete_error', 'Error deleting clients: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(
        t('alerts.clients_delete_partial', 'Deleted {ok} client(s); {failed} failed: {msg}', { ok: succeeded, failed: failures.length, msg: failures.join('; ') }),
        'warn'
      );
    }
    setSelected(new Set());
    setDeleting(false);
    // Keeps the vanilla `clients` global in sync for still-vanilla consumers (Excel import's
    // duplicate check, Tech Screen, Pending Samples) — its refreshVisibleTables() call fires
    // 'lab:refresh-clients', which this component is already listening for above.
    await window.loadInitialData();
  }

  const allChecked = data.items.length > 0 && data.items.every((c) => selected.has(c.id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1>{t('sidebar.patients', 'Patient Directory')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('patients.subtitle', 'Manage all registered laboratory clients')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input type="file" id="import-patient-excel" accept=".xlsx, .xls, .csv" style={{ display: 'none' }} onChange={handleImportChange} />
          <button
            className="btn ghost"
            style={{ borderColor: '#3b82f6', color: '#3b82f6' }}
            onClick={() => document.getElementById('import-patient-excel')?.click()}
          >
            📤 Import Excel
          </button>
          <button className="btn" style={{ background: 'var(--teal)', color: '#04121d', fontWeight: 'bold' }} onClick={handleAddNewPatient}>
            + {t('actions.add_patient', 'Add New Patient')}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 20, display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder={t('filters.search_patients', 'Search Code, Name, Phone...')}
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
        <div style={{ width: 120 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            {t('filters.gender', 'Gender')}
          </label>
          <select style={filterInputStyle} value={filters.gender} onChange={(e) => updateFilter({ gender: e.target.value })}>
            <option value="">{t('filters.all_genders', 'All Genders')}</option>
            <option value="Male">{t('gender.male', 'Male')}</option>
            <option value="Female">{t('gender.female', 'Female')}</option>
          </select>
        </div>
        <div style={{ width: 140 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            {t('filters.status', 'Status')}
          </label>
          <select style={filterInputStyle} value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })}>
            <option value="">{t('filters.all_statuses', 'All Statuses')}</option>
            <option value="registered">{t('status.registered', 'Registered')}</option>
            <option value="pending">{t('status.pending', 'Pending')}</option>
            <option value="collected">{t('status.collected', 'Sample Collected')}</option>
          </select>
        </div>
      </div>

      {data.items.length === 0 && (
        <div style={{ display: 'block', textAlign: 'center', padding: 40, background: 'rgba(0,0,0,0.2)', borderRadius: 8, border: '1px dashed var(--border)', marginBottom: 20 }}>
          <p style={{ color: 'var(--text)', fontSize: 16, marginBottom: 10 }}>{t('empty_state.no_patients', 'No patients found matching your search.')}</p>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
        {selected.size > 0 && (
          <button className="btn btn-danger" onClick={handleBulkDelete} disabled={deleting}>
            Delete Selected
          </button>
        )}
        <button
          className="btn ghost"
          style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
          onClick={(e) => window.exportTableToExcel(e.currentTarget, 'patient_directory', '#clients-table-container .table-container')}
        >
          📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
        </button>
      </div>

      <div id="clients-table-container" className="table-container">
        <table id="clients-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
              </th>
              <th>{t('table_headers.code', 'Code')}</th>
              <th>{t('table_headers.reg_date', 'Reg. Date')}</th>
              <th>{t('table_headers.name', 'Name')}</th>
              <th>{t('table_headers.gender', 'Gender')}</th>
              <th>{t('table_headers.phone', 'Phone Number')}</th>
              <th>{t('table_headers.latest_status', 'Status')}</th>
              <th style={{ textAlign: 'right' }}>{t('table_headers.action', 'Action')}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>
                  {t('alerts.empty_no_patients_filtered', 'No patients found matching your filters.')}
                </td>
              </tr>
            ) : (
              data.items.map((c) => {
                const badge = statusBadge(c, t);
                return (
                  <tr key={c.id}>
                    <td>
                      <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggleRow(c.id, e.target.checked)} />
                    </td>
                    <td>
                      <strong>2024{String(c.id).padStart(4, '0')}</strong>
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{c.created_at ? window.formatCairoDateTime(c.created_at, false) : 'N/A'}</td>
                    <td>
                      {c.first_name} {c.last_name}
                    </td>
                    <td>
                      <span className="pill ghost">{c.gender}</span>
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{c.phone || 'N/A'}</td>
                    <td>
                      <span className={`pill ${badge.pillClass}`}>{badge.text}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => window.quickEditPatient(c.id)}>
                        Review Profile
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 15 }}>
        <PaginationControls state={data} onPageChange={setPage} />
      </div>
    </>
  );
}
