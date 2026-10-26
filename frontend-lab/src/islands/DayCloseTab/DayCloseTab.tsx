import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import LogReferralModal from './LogReferralModal';
import EditReferralModal from './EditReferralModal';
import DetailModal from './DetailModal';
import { onNavTabClick } from '../../lib/onNavTabClick';

export interface ReferralRow {
  id: number;
  visit_id: number;
  lab_test_id: number;
  external_lab_name: string;
  sent_date: string | null;
  status: string;
  received_date: string | null;
  reference_no: string | null;
  notes: string | null;
  fee: number | null;
  fee_payment_status: string;
  payment_id: number | null;
  patient_name: string;
  test_name: string;
}

interface VisitDetailRow {
  visit_id: number;
  visit_code: string;
  patient_name: string;
  date: string;
  gender: string;
  physician: string;
  tests: string[];
}

interface ResultDetailRow {
  patient_name: string;
  test_name: string;
  parameter_name: string;
  result_value: string;
  status: string;
}

interface DayCloseSummary {
  date: string;
  revenue: { billed: number; collected: number; outstanding: number };
  transactions_count: number;
  visits_count: number;
  patients_count: number;
  gender_breakdown: Record<string, number>;
  physicians: { name: string; count: number }[];
  tests_ordered: { test_name: string; count: number }[];
  results_breakdown: Record<string, number>;
  payments_total: number;
  payments_count: number;
  visits_detail: VisitDetailRow[];
  results_detail: ResultDetailRow[];
  lab_to_lab: { sent_today: number; pending: ReferralRow[]; awaiting_payment: ReferralRow[] };
}

// Port of script_lab.js's cairoDateStr() — "YYYY-MM-DD" as it reads in Africa/Cairo local
// time, matching the server-stamped date strings /api/day-close/summary filters by (it uses
// now_cairo(), not UTC) regardless of the viewing browser's own OS timezone. Kept as its own
// local copy rather than a shared helper — see FinancialOverviewTab.tsx's identical copy.
function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

const EMPTY: DayCloseSummary = {
  date: todayStr(),
  revenue: { billed: 0, collected: 0, outstanding: 0 },
  transactions_count: 0,
  visits_count: 0,
  patients_count: 0,
  gender_breakdown: {},
  physicians: [],
  tests_ordered: [],
  results_breakdown: {},
  payments_total: 0,
  payments_count: 0,
  visits_detail: [],
  results_detail: [],
  lab_to_lab: { sent_today: 0, pending: [], awaiting_payment: [] },
};

interface DetailState {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
}

export default function DayCloseTab() {
  const { t } = useTranslations();
  const [date, setDate] = useState(todayStr());
  const [summary, setSummary] = useState<DayCloseSummary>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [showReferralModal, setShowReferralModal] = useState(false);
  const [editingReferral, setEditingReferral] = useState<ReferralRow | null>(null);
  const [busyReferralId, setBusyReferralId] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [detail, setDetail] = useState<DetailState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/day-close/summary?date=${date}`)
      .then((res) => (res.ok ? (res.json() as Promise<DayCloseSummary>) : null))
      .then((json) => {
        // Without this guard, a slow request for a date the user has since navigated away
        // from can resolve AFTER the request for the newly-picked date and silently overwrite
        // it with stale data (observed: forcing the date picker straight to a past date could
        // still leave "today"'s empty summary on screen if that first request settled last).
        if (!cancelled && json) setSummary(json);
      })
      .catch((err) => !cancelled && console.error('Failed to load day-close summary:', err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [date, refreshTick]);

  function load() {
    setRefreshTick((n) => n + 1);
  }

  // Day Close aggregates data owned by other tabs (a checkout's transaction/visit, a Payments
  // entry, a Lab Referral) — none of which re-render this already-mounted island on their own,
  // so without this it kept showing whatever it first loaded until a full page reload. Same
  // nav-tab click / lab:refresh-* CustomEvent bridge as every other migrated tab (see
  // TransactionHistoryTab.tsx) — bumps refreshTick (never the fetch itself, so this listener
  // never closes over a stale `date`) both when this tab is actually clicked into and whenever
  // a checkout/payment/referral elsewhere fires the matching event.
  useEffect(() => {
    const onRefresh = () => setRefreshTick((n) => n + 1);
    const offTabClick = onNavTabClick('day-close', onRefresh);
    window.addEventListener('lab:refresh-day-close', onRefresh);
    return () => {
      offTabClick();
      window.removeEventListener('lab:refresh-day-close', onRefresh);
    };
  }, []);

  async function markReceived(referral: ReferralRow) {
    setBusyReferralId(referral.id);
    try {
      const res = await apiFetch(`/api/lab-referrals/${referral.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'received' }),
      });
      if (!res.ok) throw new Error('Server rejected the update');
      window.showAlert(t('day_close.referral_marked_received', 'Marked as received.'), 'success');
      load();
    } catch (err) {
      window.showAlert(t('day_close.referral_update_error', 'Error updating referral: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setBusyReferralId(null);
    }
  }

  async function markFeePaid(referral: ReferralRow) {
    setBusyReferralId(referral.id);
    try {
      const res = await apiFetch(`/api/lab-referrals/${referral.id}/pay`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server rejected the payment');
      }
      window.showAlert(t('day_close.referral_fee_paid', 'Fee marked paid and added to Payments.'), 'success');
      load();
      // The server just created the matching Payment row — tell the (already-mounted)
      // Payments tab to re-fetch so it's listed there right away.
      window.dispatchEvent(new CustomEvent('lab:refresh-payments'));
    } catch (err) {
      window.showAlert(t('day_close.referral_update_error', 'Error updating referral: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setBusyReferralId(null);
    }
  }

  function openTestDetail(testName: string) {
    const rows = summary.visits_detail
      .filter((v) => v.tests.includes(testName))
      .map((v) => ({ date: v.date, patient_name: v.patient_name, visit_code: v.visit_code, physician: v.physician }));
    setDetail({
      title: `${t('table_headers.test', 'Test')}: ${testName}`,
      columns: [
        { key: 'date', label: t('table_headers.date', 'Date') },
        { key: 'patient_name', label: t('table_headers.patient', 'Patient') },
        { key: 'visit_code', label: t('day_close.visit', 'Visit') },
        { key: 'physician', label: t('day_close.physician', 'Physician') },
      ],
      rows,
    });
  }

  function openPhysicianDetail(name: string) {
    const rows = summary.visits_detail
      .filter((v) => v.physician === name)
      .map((v) => ({ date: v.date, patient_name: v.patient_name, visit_code: v.visit_code, tests: v.tests.join(', ') }));
    setDetail({
      title: `${t('day_close.physician', 'Physician')}: ${name}`,
      columns: [
        { key: 'date', label: t('table_headers.date', 'Date') },
        { key: 'patient_name', label: t('table_headers.patient', 'Patient') },
        { key: 'visit_code', label: t('day_close.visit', 'Visit') },
        { key: 'tests', label: t('day_close.tests_ordered', 'Tests Ordered') },
      ],
      rows,
    });
  }

  function openGenderDetail(gender: string) {
    const rows = summary.visits_detail
      .filter((v) => v.gender === gender)
      .map((v) => ({ date: v.date, patient_name: v.patient_name, visit_code: v.visit_code, physician: v.physician }));
    setDetail({
      title: `${t('day_close.gender', 'Gender')}: ${gender}`,
      columns: [
        { key: 'date', label: t('table_headers.date', 'Date') },
        { key: 'patient_name', label: t('table_headers.patient', 'Patient') },
        { key: 'visit_code', label: t('day_close.visit', 'Visit') },
        { key: 'physician', label: t('day_close.physician', 'Physician') },
      ],
      rows,
    });
  }

  function openResultDetail(status: string) {
    const rows = summary.results_detail
      .filter((r) => r.status === status)
      .map((r) => ({ patient_name: r.patient_name, test_name: r.test_name, parameter_name: r.parameter_name, result_value: r.result_value }));
    setDetail({
      title: `${t('day_close.results', 'Results')}: ${status}`,
      columns: [
        { key: 'patient_name', label: t('table_headers.patient', 'Patient') },
        { key: 'test_name', label: t('table_headers.test', 'Test') },
        { key: 'parameter_name', label: t('day_close.parameter', 'Parameter') },
        { key: 'result_value', label: t('day_close.result_value', 'Result') },
      ],
      rows,
    });
  }

  const cardStyle = { flex: 1, minWidth: 160, padding: 16, textAlign: 'center' as const };
  const sectionStyle = { marginBottom: 24 };
  const clickableRowStyle = { cursor: 'pointer' } as const;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>{t('day_close.title', 'Day Close')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('day_close.subtitle', "One day's operations: revenue, tests, physicians, patients, results, and outsourced samples")}</p>
        </div>
        <div>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>{t('day_close.date', 'Date')}</label>
          <input
            type="date"
            style={{ padding: 8, borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: 'white' }}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="glass-panel" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>{t('generic.loading', 'Loading...')}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 15, marginBottom: 20, flexWrap: 'wrap' }}>
            <div className="card" style={cardStyle}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('day_close.net_revenues', 'Net Revenues')}</div>
              <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--ok)' }}>{summary.revenue.collected.toFixed(2)} EGP</div>
            </div>
            <div className="card" style={cardStyle}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('day_close.net_payments', 'Net Payments')}</div>
              <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--danger)' }}>{summary.payments_total.toFixed(2)} EGP</div>
            </div>
            <div className="card" style={cardStyle}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('day_close.visits', 'Visits / Patients')}</div>
              <div style={{ fontSize: 22, fontWeight: 'bold' }}>{summary.visits_count} / {summary.patients_count}</div>
            </div>
            <div className="card" style={cardStyle}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>{t('day_close.outstanding', 'Outstanding to Collect')}</div>
              <div style={{ fontSize: 22, fontWeight: 'bold', color: 'var(--warn)' }}>{summary.revenue.outstanding.toFixed(2)} EGP</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
            <div className="glass-panel" style={{ flex: '1 1 320px', padding: 18 }}>
              <h3 style={{ marginBottom: 12 }}>{t('day_close.tests_ordered', 'Tests Ordered')}</h3>
              {summary.tests_ordered.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>{t('day_close.no_data', 'No data for this day.')}</div>
              ) : (
                <table className="admin-table" style={{ width: '100%' }}>
                  <thead>
                    <tr><th>{t('table_headers.test', 'Test')}</th><th style={{ textAlign: 'right' }}>{t('day_close.count', 'Count')}</th></tr>
                  </thead>
                  <tbody>
                    {summary.tests_ordered.map((row) => (
                      <tr key={row.test_name} style={clickableRowStyle} onClick={() => openTestDetail(row.test_name)}>
                        <td>{row.test_name}</td><td style={{ textAlign: 'right' }}>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="glass-panel" style={{ flex: '1 1 320px', padding: 18 }}>
              <h3 style={{ marginBottom: 12 }}>{t('day_close.physicians', 'Physicians')}</h3>
              {summary.physicians.length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>{t('day_close.no_data', 'No data for this day.')}</div>
              ) : (
                <table className="admin-table" style={{ width: '100%' }}>
                  <thead>
                    <tr><th>{t('day_close.physician', 'Physician')}</th><th style={{ textAlign: 'right' }}>{t('day_close.visits_count', 'Visits')}</th></tr>
                  </thead>
                  <tbody>
                    {summary.physicians.map((row) => (
                      <tr key={row.name} style={clickableRowStyle} onClick={() => openPhysicianDetail(row.name)}>
                        <td>{row.name}</td><td style={{ textAlign: 'right' }}>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
            <div className="glass-panel" style={{ flex: '1 1 240px', padding: 18 }}>
              <h3 style={{ marginBottom: 12 }}>{t('day_close.gender', 'Gender')}</h3>
              {Object.keys(summary.gender_breakdown).length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>{t('day_close.no_data', 'No data for this day.')}</div>
              ) : (
                Object.entries(summary.gender_breakdown).map(([gender, count]) => (
                  <div key={gender} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', ...clickableRowStyle }} onClick={() => openGenderDetail(gender)}>
                    <span>{gender}</span><strong>{count}</strong>
                  </div>
                ))
              )}
            </div>

            <div className="glass-panel" style={{ flex: '1 1 240px', padding: 18 }}>
              <h3 style={{ marginBottom: 12 }}>{t('day_close.results', 'Results')}</h3>
              {Object.keys(summary.results_breakdown).length === 0 ? (
                <div style={{ color: 'var(--muted)' }}>{t('day_close.no_data', 'No data for this day.')}</div>
              ) : (
                Object.entries(summary.results_breakdown).map(([status, count]) => (
                  <div key={status} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', ...clickableRowStyle }} onClick={() => openResultDetail(status)}>
                    <span style={{ textTransform: 'capitalize' }}>{status}</span><strong>{count}</strong>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="glass-panel" style={{ padding: 18, ...sectionStyle }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <h3>
                {t('day_close.lab_to_lab', 'Lab-to-Lab')} — {t('day_close.sent_today', '{count} sent today', { count: summary.lab_to_lab.sent_today })}
              </h3>
              <button className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={() => setShowReferralModal(true)}>
                ➕ {t('day_close.log_referral', 'Log Referral')}
              </button>
            </div>
            {summary.lab_to_lab.pending.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>{t('day_close.no_pending_referrals', 'Nothing still out for testing.')}</div>
            ) : (
              <table className="admin-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{t('day_close.sent_date', 'Sent')}</th>
                    <th>{t('table_headers.patient', 'Patient')}</th>
                    <th>{t('table_headers.test', 'Test')}</th>
                    <th>{t('day_close.external_lab', 'External Lab')}</th>
                    <th style={{ textAlign: 'right' }}>{t('day_close.fee', 'Fee')}</th>
                    <th>{t('table_headers.actions', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.lab_to_lab.pending.map((r) => (
                    <tr key={r.id}>
                      <td style={{ color: 'var(--muted)' }}>{r.sent_date}</td>
                      <td>{r.patient_name}</td>
                      <td>{r.test_name}</td>
                      <td>{r.external_lab_name}</td>
                      <td style={{ textAlign: 'right' }}>{r.fee != null ? `${r.fee.toFixed(2)} EGP` : '—'}</td>
                      <td>
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => markReceived(r)} disabled={busyReferralId === r.id}>
                          ✅ {t('day_close.mark_received', 'Mark Received')}
                        </button>{' '}
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setEditingReferral(r)} disabled={busyReferralId === r.id}>
                          ✏️ {t('actions.edit', 'Edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="glass-panel" style={{ padding: 18, ...sectionStyle }}>
            <h3 style={{ marginBottom: 12 }}>{t('day_close.awaiting_payment', 'Lab-to-Lab — Awaiting Fee Payment')}</h3>
            {summary.lab_to_lab.awaiting_payment.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>{t('day_close.no_awaiting_payment', 'No received referrals with an unpaid fee.')}</div>
            ) : (
              <table className="admin-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{t('day_close.received_date', 'Received')}</th>
                    <th>{t('table_headers.patient', 'Patient')}</th>
                    <th>{t('table_headers.test', 'Test')}</th>
                    <th>{t('day_close.external_lab', 'External Lab')}</th>
                    <th style={{ textAlign: 'right' }}>{t('day_close.fee', 'Fee')}</th>
                    <th>{t('table_headers.actions', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.lab_to_lab.awaiting_payment.map((r) => (
                    <tr key={r.id}>
                      <td style={{ color: 'var(--muted)' }}>{r.received_date}</td>
                      <td>{r.patient_name}</td>
                      <td>{r.test_name}</td>
                      <td>{r.external_lab_name}</td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold', color: 'var(--warn)' }}>{r.fee != null ? `${r.fee.toFixed(2)} EGP` : '—'}</td>
                      <td>
                        <button className="btn" style={{ padding: '4px 10px', fontSize: 11, background: 'var(--teal)', color: '#04121d' }} onClick={() => markFeePaid(r)} disabled={busyReferralId === r.id}>
                          💸 {t('day_close.mark_paid', 'Mark Paid')}
                        </button>{' '}
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setEditingReferral(r)} disabled={busyReferralId === r.id}>
                          ✏️ {t('actions.edit', 'Edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showReferralModal && (
        <LogReferralModal
          onClose={() => setShowReferralModal(false)}
          onSaved={() => {
            setShowReferralModal(false);
            load();
          }}
        />
      )}

      {editingReferral && (
        <EditReferralModal
          referral={editingReferral}
          onClose={() => setEditingReferral(null)}
          onSaved={() => {
            setEditingReferral(null);
            load();
          }}
        />
      )}

      {detail && (
        <DetailModal
          title={detail.title}
          columns={detail.columns}
          rows={detail.rows}
          emptyText={t('day_close.no_data', 'No data for this day.')}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
