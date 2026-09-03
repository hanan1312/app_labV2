import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';
import CompletePaymentModal from './CompletePaymentModal';

export interface TransactionRow {
  id: number;
  transaction_id: string;
  patient_id: number;
  patient_name: string;
  date: string;
  tests: string[];
  total_price: number;
  discount_percentage: number;
  payment_method: string;
  final_payment: number;
  amount_paid: number;
  remaining_fees: number;
}

interface PagedTransactions {
  items: TransactionRow[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  total_remaining: number;
}

interface TransactionsSummary {
  today: number;
  this_week: number;
  this_month: number;
}

const EMPTY: PagedTransactions = { items: [], page: 1, per_page: 100, total: 0, total_pages: 1, total_remaining: 0 };
const EMPTY_SUMMARY: TransactionsSummary = { today: 0, this_week: 0, this_month: 0 };

const filterInputStyle = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
} as const;

export default function TransactionHistoryTab() {
  const { t } = useTranslations();

  const [data, setData] = useState<PagedTransactions>(EMPTY);
  const [summary, setSummary] = useState<TransactionsSummary>(EMPTY_SUMMARY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ dateFrom: '', dateTo: '', unpaidOnly: false });
  const [refreshTick, setRefreshTick] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [completePaymentRow, setCompletePaymentRow] = useState<TransactionRow | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), per_page: '100' });
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.unpaidOnly) params.set('unpaid_only', 'true');

    let cancelled = false;
    apiFetch(`/api/transactions?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedTransactions>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load transactions:', err));
    return () => {
      cancelled = true;
    };
  }, [page, filters, refreshTick]);

  function loadSummary() {
    apiFetch('/api/transactions/summary')
      .then((res) => (res.ok ? (res.json() as Promise<TransactionsSummary>) : null))
      .then((json) => json && setSummary(json))
      .catch((err) => console.error('Failed to load transactions summary:', err));
  }

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-transaction-history CustomEvent bridge as
  // every other migrated tab (dispatched from refreshVisibleTables()). Doesn't clear the date/
  // unpaid-only filters on tab entry — matches the vanilla filterTransactions(), which only
  // ever read whatever was already sitting in the (persistent) filter inputs, never cleared
  // them itself; only the "Clear Filter" button did that.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="transaction-history"]');
    const onTabClick = () => {
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    const onExternalRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-transaction-history', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-transaction-history', onExternalRefresh);
    };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [filters, page]);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function clearDateFilter() {
    updateFilter({ dateFrom: '', dateTo: '' });
  }

  function refresh() {
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
    setSelected(checked ? new Set(data.items.map((r) => r.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_transactions', "Delete {count} transaction(s)? This cannot be undone and does not affect the underlying visit/order.", { count: ids.length })))
      return;
    setDeleting(true);
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/transactions/${id}`, { method: 'DELETE' });
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
      window.showAlert(t('alerts.transactions_deleted', 'Deleted {count} transaction(s).', { count: succeeded }), 'success');
    } else if (succeeded === 0) {
      window.showAlert(t('alerts.transactions_delete_error', 'Error deleting transactions: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(
        t('alerts.transactions_delete_partial', 'Deleted {ok} transaction(s); {failed} failed: {msg}', { ok: succeeded, failed: failures.length, msg: failures.join('; ') }),
        'warn'
      );
    }
    setSelected(new Set());
    setDeleting(false);
    refresh();
    loadSummary();
    // Keeps Financial Overview's revenue totals (and the checkout modal's payment-method
    // suggestions) in sync — both still read the vanilla `allTransactions` global directly.
    window.fetchTransactionsData?.();
  }

  const allChecked = data.items.length > 0 && data.items.every((r) => selected.has(r.id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('history.title', 'Transaction History')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('history.subtitle', 'View and filter all patient payments')}</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 15, marginBottom: 20, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('history.total_today', 'Total Paid Today')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--ok)' }}>{summary.today.toFixed(2)} EGP</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('history.total_week', 'Total Paid This Week')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--ok)' }}>{summary.this_week.toFixed(2)} EGP</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('history.total_month', 'Total Paid This Month')}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--ok)' }}>{summary.this_month.toFixed(2)} EGP</div>
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
        <button className="btn ghost" onClick={clearDateFilter}>
          {t('history.clear_filter', 'Clear Filter')}
        </button>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 38,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid rgba(239, 107, 107, 0.3)',
            background: 'rgba(239, 107, 107, 0.1)',
            color: 'var(--danger)',
            fontSize: 13,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <input type="checkbox" checked={filters.unpaidOnly} onChange={(e) => updateFilter({ unpaidOnly: e.target.checked })} />
          🚩 Show Unpaid Only
        </label>
      </div>

      {data.total_remaining > 0 && (
        <div
          style={{
            marginBottom: 15,
            padding: '12px 18px',
            borderRadius: 8,
            background: 'rgba(239, 107, 107, 0.1)',
            border: '1px solid rgba(239, 107, 107, 0.3)',
            color: 'var(--danger)',
            fontWeight: 600,
          }}
        >
          🚩 Total Remaining to Collect: {data.total_remaining.toFixed(2)} EGP
        </div>
      )}

      <div id="transactions-list-container">
        {data.items.length === 0 ? (
          <div className="glass-panel" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
            {filters.unpaidOnly
              ? t('alerts.empty_no_unpaid_transactions', 'No unpaid transactions found.')
              : t('alerts.empty_no_transactions_date', 'No transactions found for this date.')}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 15, gap: 8 }}>
              {selected.size > 0 && (
                <button className="btn btn-danger" style={{ padding: '6px 12px', fontSize: 12 }} onClick={handleBulkDelete} disabled={deleting}>
                  🗑️ {t('actions.delete_selected', 'Delete Selected')}
                </button>
              )}
              <button
                className="btn ghost"
                style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '6px 12px', fontSize: 12 }}
                onClick={(e) => window.exportTableToExcel(e.currentTarget, 'transaction_history', '#transactions-list-container .table-container')}
              >
                📥 {t('actions.export_excel', 'Export to Excel')}
              </button>
            </div>
            <div className="table-container glass-panel">
              <table className="admin-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
                    </th>
                    <th>Date</th>
                    <th>Trans ID</th>
                    <th>Patient</th>
                    <th>Tests Included</th>
                    <th>Method</th>
                    <th>Discount</th>
                    <th style={{ textAlign: 'right' }}>Paid</th>
                    <th style={{ textAlign: 'right' }}>Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => {
                    const remaining = row.remaining_fees || 0;
                    return (
                      <tr key={row.id}>
                        <td>
                          <input type="checkbox" checked={selected.has(row.id)} onChange={(e) => toggleRow(row.id, e.target.checked)} />
                        </td>
                        <td style={{ color: 'var(--muted)' }}>{window.formatCairoDateTime(row.date, false)}</td>
                        <td>
                          <strong>{row.transaction_id}</strong>
                        </td>
                        <td>{row.patient_name}</td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>{row.tests.join(', ')}</td>
                        <td>{row.payment_method}</td>
                        <td style={{ color: 'var(--warn)' }}>{row.discount_percentage}%</td>
                        <td style={{ color: 'var(--ok)', fontWeight: 'bold', textAlign: 'right' }}>{(row.amount_paid ?? row.final_payment).toFixed(2)} EGP</td>
                        <td style={{ textAlign: 'right' }}>
                          {remaining > 0 ? (
                            <>
                              <span className="pill danger">🚩 {remaining.toFixed(2)} EGP owed</span>
                              <button
                                className="btn ghost"
                                style={{ padding: '4px 10px', fontSize: 11, marginLeft: 6 }}
                                onClick={() => setCompletePaymentRow(row)}
                              >
                                💰 Complete Payment
                              </button>
                            </>
                          ) : (
                            <span className="pill ok">Fully Paid</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationControls state={data} onPageChange={setPage} />
          </>
        )}
      </div>

      {completePaymentRow && (
        <CompletePaymentModal
          transaction={completePaymentRow}
          onClose={() => setCompletePaymentRow(null)}
          onPaid={() => {
            setCompletePaymentRow(null);
            refresh();
          }}
        />
      )}
    </>
  );
}
