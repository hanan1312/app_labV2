import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';

interface VisitRow {
  id: number;
  visit_id: string;
  patient_name: string;
  date: string;
  tests: string[];
  test_ids: number[];
}

interface PagedVisits {
  items: VisitRow[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

const EMPTY: PagedVisits = { items: [], page: 1, per_page: 10, total: 0, total_pages: 1 };

// Port of script_lab.js's cairoDateStr() — "YYYY-MM-DD" as it reads in Africa/Cairo local
// time, matching the server-stamped date strings this app keys everything else off (it uses
// now_cairo(), not UTC) regardless of the viewing browser's own OS timezone. Kept as its own
// local copy rather than a shared helper — see FinancialOverviewTab.tsx's identical copy.
function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function LogReferralModal({ onClose, onSaved }: Props) {
  const { t } = useTranslations();

  const [data, setData] = useState<PagedVisits>(EMPTY);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '' });
  const [loading, setLoading] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<VisitRow | null>(null);
  const [labTestId, setLabTestId] = useState<number | ''>('');
  const [externalLabName, setExternalLabName] = useState('');
  const [fee, setFee] = useState('');
  const [sentDate, setSentDate] = useState(todayStr());
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // The visits table only matters while no visit is picked yet — no need to keep fetching
  // pages in the background once the form step below takes over.
  useEffect(() => {
    if (selectedVisit) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), per_page: '10' });
    if (filters.search.trim()) params.set('search', filters.search.trim());
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);

    let cancelled = false;
    apiFetch(`/api/visits?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<PagedVisits>) : null))
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => console.error('Failed to load visits:', err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, filters, selectedVisit]);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function pickVisit(visit: VisitRow) {
    setSelectedVisit(visit);
    setLabTestId('');
  }

  async function handleSubmit() {
    if (!selectedVisit || !labTestId || !externalLabName.trim()) {
      window.showAlert(t('day_close.referral_missing_fields', 'Pick a visit and test, and name the external lab.'), 'warn');
      return;
    }
    let feeValue: number | null = null;
    if (fee.trim()) {
      feeValue = parseFloat(fee);
      if (!Number.isFinite(feeValue) || feeValue < 0) {
        window.showAlert(t('alerts.enter_valid_amount', 'Enter a valid amount.'), 'warn');
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/lab-referrals', {
        method: 'POST',
        body: JSON.stringify({
          visit_id: selectedVisit.id,
          lab_test_id: labTestId,
          external_lab_name: externalLabName.trim(),
          sent_date: sentDate,
          fee: feeValue,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Server rejected the referral');
      window.showAlert(t('day_close.referral_logged', 'Referral logged.'), 'success');
      onSaved();
    } catch (err) {
      window.showAlert(t('day_close.referral_save_error', 'Error logging referral: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setSubmitting(false);
    }
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
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: selectedVisit ? 480 : 720 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 15, color: 'var(--text)' }}>{t('day_close.log_referral', 'Log Referral')}</h2>

        {!selectedVisit ? (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: 2, minWidth: 180 }}>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('day_close.search_visit', 'Search by ID, patient name, or phone')}
                </label>
                <input
                  type="text"
                  style={filterInputStyle}
                  value={filters.search}
                  onChange={(e) => updateFilter({ search: e.target.value })}
                />
              </div>
              <div style={{ width: 140 }}>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('filters.from_date', 'From Date')}</label>
                <input type="date" style={filterInputStyle} value={filters.dateFrom} onChange={(e) => updateFilter({ dateFrom: e.target.value })} />
              </div>
              <div style={{ width: 140 }}>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('filters.to_date', 'To Date')}</label>
                <input type="date" style={filterInputStyle} value={filters.dateTo} onChange={(e) => updateFilter({ dateTo: e.target.value })} />
              </div>
              {(filters.search || filters.dateFrom || filters.dateTo) && (
                <button className="btn ghost" onClick={() => updateFilter({ search: '', dateFrom: '', dateTo: '' })}>
                  {t('history.clear_filter', 'Clear Filter')}
                </button>
              )}
            </div>

            {loading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>{t('generic.loading', 'Loading...')}</div>
            ) : data.items.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>{t('day_close.no_visits_found', 'No visits found for this filter.')}</div>
            ) : (
              <>
                <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}>
                  <table className="admin-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>{t('table_headers.date', 'Date')}</th>
                        <th>{t('table_headers.patient', 'Patient')}</th>
                        <th>{t('day_close.tests_ordered', 'Tests Ordered')}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((v) => (
                        <tr key={v.id}>
                          <td style={{ color: 'var(--muted)' }}>{v.date}</td>
                          <td>
                            <strong>{v.patient_name}</strong>
                            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{v.visit_id}</div>
                          </td>
                          <td style={{ fontSize: 12 }}>{v.tests.join(', ')}</td>
                          <td>
                            <button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => pickVisit(v)}>
                              {t('day_close.select_visit', 'Select')}
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
          </>
        ) : (
          <>
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8, marginBottom: 14 }}>
              <p><strong>{t('table_headers.patient', 'Patient')}:</strong> {selectedVisit.patient_name}</p>
              <p><strong>{t('day_close.visit', 'Visit')}:</strong> {selectedVisit.visit_id}</p>
              <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11, marginTop: 6 }} onClick={() => setSelectedVisit(null)}>
                {t('day_close.change_visit', 'Change Visit')}
              </button>
            </div>

            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('table_headers.test', 'Test')}</label>
            <select style={{ width: '100%', marginBottom: 14 }} value={labTestId} onChange={(e) => setLabTestId(Number(e.target.value))}>
              <option value="">{t('forms.select', 'Select')}</option>
              {selectedVisit.tests.map((name, i) => (
                <option key={selectedVisit.test_ids[i]} value={selectedVisit.test_ids[i]}>{name}</option>
              ))}
            </select>

            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('day_close.external_lab', 'External Lab')}</label>
                <input type="text" style={{ width: '100%' }} value={externalLabName} onChange={(e) => setExternalLabName(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('day_close.sent_date', 'Sent')}</label>
                <input type="date" style={{ width: '100%' }} value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
              </div>
            </div>

            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('day_close.fee', 'Fee owed to external lab (EGP)')}</label>
            <input type="number" step="0.01" min="0" style={{ width: '100%', marginBottom: 14 }} value={fee} onChange={(e) => setFee(e.target.value)} />

            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('payments.notes', 'Notes')}</label>
            <textarea style={{ width: '100%', marginBottom: 20, minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} />

            <button
              className="btn"
              style={{ width: '100%', background: 'var(--teal)', color: '#04121d', fontSize: 15, padding: 10 }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              ✅ {t('actions.save', 'Save')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
