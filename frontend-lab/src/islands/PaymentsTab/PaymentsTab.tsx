import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import PaymentModal from './PaymentModal';

export interface PaymentRow {
  id: number;
  category: string;
  description: string;
  amount: number;
  paid_to: string | null;
  payment_method: string | null;
  payment_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string | null;
}

interface PagedPayments {
  items: PaymentRow[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  total_amount: number;
}

interface PaymentsSummary {
  today: number;
  this_week: number;
  this_month: number;
}

const EMPTY: PagedPayments = { items: [], page: 1, per_page: 100, total: 0, total_pages: 1, total_amount: 0 };
const EMPTY_SUMMARY: PaymentsSummary = { today: 0, this_week: 0, this_month: 0 };

const filterInputStyle = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
} as const;

export default function PaymentsTab() {
  const { t } = useTranslations();

  const [data, setData] = useState<PagedPayments>(EMPTY);
  const [summary, setSummary] = useState<PaymentsSummary>(EMPTY_SUMMARY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ dateFrom: '', dateTo: '', category: '' });
  const [refreshTick, setRefreshTick] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [editRow, setEditRow] = useState<PaymentRow | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100' });
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.category) params.set('category', filters.category);

    let cancelled = false;
    apiFetch(`/api/payments?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedPayments>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load payments:', err));
    return () => {
      cancelled = true;
    };
  }, [page, filters, refreshTick]);

  function loadSummary() {
    apiFetch('/api/payments/summary')
      .then((res) => (res.ok ? (res.json() as Promise<PaymentsSummary>) : null))
      .then((json) => json && setSummary(json))
      .catch((err) => console.error('Failed to load payments summary:', err));
  }

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-* CustomEvent bridge as every other
  // migrated tab (see TransactionHistoryTab.tsx).
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="payments"]');
    const onTabClick = () => {
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-payments', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-payments', onExternalRefresh);
    };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [filters, page]);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function clearFilters() {
    updateFilter({ dateFrom: '', dateTo: '', category: '' });
  }

  function refresh() {
    setRefreshTick((n) => n + 1);
    // Day Close's revenue/net figures include Payments — same lab:refresh-* CustomEvent
    // bridge the vanilla checkout flow uses (see refreshVisibleTables() in script_lab.js) so
    // Day Close doesn't need a page reload to pick up a payment logged just now.
    window.dispatchEvent(new CustomEvent('lab:refresh-day-close'));
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
    setSelected(checked ? new Set(data.items.map((r) => r.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('payments.confirm_delete', 'Delete {count} payment(s)? This cannot be undone.', { count: ids.length })))
      return;
    setDeleting(true);
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/payments/${id}`, { method: 'DELETE' });
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
      window.showAlert(t('payments.deleted', 'Deleted {count} payment(s).', { count: succeeded }), 'success');
    } else if (succeeded === 0) {
      window.showAlert(t('payments.delete_error', 'Error deleting payments: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(
        t('payments.delete_partial', 'Deleted {ok} payment(s); {failed} failed: {msg}', { ok: succeeded, failed: failures.length, msg: failures.join('; ') }),
        'warn'
      );
    }
    setSelected(new Set());
    setDeleting(false);
    refresh();
    loadSummary();
  }

  const allChecked = data.items.length > 0 && data.items.every((r) => selected.has(r.id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('payments.title', 'Payments')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('payments.subtitle', 'Money paid out — bills, rent, and ordered services')}</p>
        </div>
        <button className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={() => setShowAddModal(true)}>
          ➕ {t('payments.add', 'Log Payment')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 15, marginBottom: 20, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('payments.total_today', 'Paid Out Today')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--danger)' }}>{summary.today.toFixed(2)} EGP</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('payments.total_week', 'Paid Out This Week')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--danger)' }}>{summary.this_week.toFixed(2)} EGP</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('payments.total_month', 'Paid Out This Month')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--danger)' }}>{summary.this_month.toFixed(2)} EGP</div>
        </div>
      </div>

      <div style={{ marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 140 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('filters.from_date', 'From Date')}</label>
          <input type="date" style={filterInputStyle} value={filters.dateFrom} onChange={(e) => updateFilter({ dateFrom: e.target.value })} />
        </div>
        <div style={{ width: 140 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('filters.to_date', 'To Date')}</label>
          <input type="date" style={filterInputStyle} value={filters.dateTo} onChange={(e) => updateFilter({ dateTo: e.target.value })} />
        </div>
        <div style={{ width: 160 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('payments.category', 'Category')}</label>
          <input list="payment-category-list" style={filterInputStyle} value={filters.category} onChange={(e) => updateFilter({ category: e.target.value })} />
        </div>
        <button className="btn ghost" onClick={clearFilters}>
          {t('history.clear_filter', 'Clear Filter')}
        </button>
      </div>

      <datalist id="payment-category-list">
        <option value="bill">Bill</option>
        <option value="rent">Rent</option>
        <option value="service">Service</option>
        <option value="supplier">Supplier</option>
        <option value="other">Other</option>
      </datalist>

      <div id="payments-list-container">
        {data.items.length === 0 ? (
          <div className="glass-panel" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
            {t('payments.empty', 'No payments logged for this filter.')}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, gap: 8 }}>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                {t('payments.total_filtered', 'Total for this filter: {amount} EGP', { amount: data.total_amount.toFixed(2) })}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {selected.size > 0 && (
                  <button className="btn btn-danger" style={{ padding: '6px 12px', fontSize: 12 }} onClick={handleBulkDelete} disabled={deleting}>
                    🗑️ {t('actions.delete_selected', 'Delete Selected')}
                  </button>
                )}
                <button
                  className="btn ghost"
                  style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '6px 12px', fontSize: 12 }}
                  onClick={(e) => window.exportTableToExcel(e.currentTarget, 'payments', '#payments-list-container .table-container')}
                >
                  📥 {t('actions.export_excel', 'Export to Excel')}
                </button>
              </div>
            </div>
            <div className="table-container glass-panel">
              <table className="admin-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
                    </th>
                    <th>{t('table_headers.date', 'Date')}</th>
                    <th>{t('payments.category', 'Category')}</th>
                    <th>{t('payments.description', 'Description')}</th>
                    <th>{t('payments.paid_to', 'Paid To')}</th>
                    <th>{t('history.method', 'Method')}</th>
                    <th style={{ textAlign: 'right' }}>{t('table_headers.amount', 'Amount')}</th>
                    <th>{t('table_headers.actions', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input type="checkbox" checked={selected.has(row.id)} onChange={(e) => toggleRow(row.id, e.target.checked)} />
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{row.payment_date}</td>
                      <td>
                        <span className="pill info">{row.category}</span>
                      </td>
                      <td>{row.description}</td>
                      <td>{row.paid_to || '—'}</td>
                      <td>{row.payment_method || '—'}</td>
                      <td style={{ color: 'var(--danger)', fontWeight: 'bold', textAlign: 'right' }}>{row.amount.toFixed(2)} EGP</td>
                      <td>
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setEditRow(row)}>
                          ✏️ {t('actions.edit', 'Edit')}
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
      </div>

      {showAddModal && (
        <PaymentModal
          onClose={() => setShowAddModal(false)}
          onSaved={() => {
            setShowAddModal(false);
            refresh();
            loadSummary();
          }}
        />
      )}
      {editRow && (
        <PaymentModal
          payment={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => {
            setEditRow(null);
            refresh();
            loadSummary();
          }}
        />
      )}
    </>
  );
}
