import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

interface Client {
  id: number;
  first_name: string;
  last_name: string;
  gender: string;
  phone: string | null;
  created_at: string | null;
}

interface Visit {
  patient_id: number;
  date: string;
  status: string;
}

// Ported from script_lab.js's isDateInRange() (script_lab.js:171) — compares just the
// YYYY-MM-DD portion so a timestamp-bearing created_at still matches a date-only filter.
function isDateInRange(targetDateStr: string | null, from: string, to: string): boolean {
  if (!targetDateStr) return false;
  const targetDate = targetDateStr.includes('T') ? targetDateStr.split('T')[0] : targetDateStr.split(' ')[0];
  if (from && targetDate < from) return false;
  if (to && targetDate > to) return false;
  return true;
}

function patientCode(id: number): string {
  return `2024${String(id).padStart(4, '0')}`;
}

// Same latest-visit-status -> pill mapping as script_lab.js's searchReports()
// (script_lab.js:2604-2720) — a visit-workflow vocabulary, distinct from StatusPill's
// test-result vocabulary, so it isn't force-reused here.
const STATUS_PILLS: Record<string, { cls: string; key: string; fallback: string }> = {
  pending: { cls: 'danger', key: 'alerts.status_pending_badge', fallback: 'Pending' },
  collected: { cls: 'warn', key: 'alerts.status_processing', fallback: 'Processing' },
  partially_delivered: { cls: 'info', key: 'alerts.status_partially_delivered', fallback: 'Partially Delivered' },
  awaiting_approval: { cls: 'warn', key: 'alerts.status_awaiting_approval', fallback: 'Waiting for Approval' },
  results_delivered_by_link: { cls: 'ok', key: 'alerts.status_results_delivered', fallback: 'Results Delivered' },
};

const filterInputStyle = {
  width: '100%',
  padding: '8px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
};

const filterLabelStyle = {
  fontSize: 11,
  textTransform: 'uppercase' as const,
  color: 'var(--muted)',
  marginBottom: 6,
  display: 'block',
};

export default function ReportsTab() {
  const { t } = useTranslations();
  const [clients, setClients] = useState<Client[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [gender, setGender] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch('/api/clients').then((res) => {
        if (!res.ok) throw new Error('Failed to fetch clients');
        return res.json() as Promise<Client[]>;
      }),
      apiFetch('/api/visits').then((res) => {
        if (!res.ok) throw new Error('Failed to fetch visits');
        return res.json() as Promise<Visit[]>;
      }),
    ])
      .then(([clientsData, visitsData]) => {
        if (cancelled) return;
        setClients(clientsData);
        setVisits(visitsData);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Re-entering the tab re-fetches (data may have changed elsewhere in the app) and clears
  // filters, matching loadReports()'s behavior (script_lab.js:2596-2603).
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="reports"]');
    const onClick = () => {
      setSearch('');
      setDateFrom('');
      setDateTo('');
      setGender('');
      setRefreshTick((n) => n + 1);
    };
    tabButton?.addEventListener('click', onClick);
    return () => tabButton?.removeEventListener('click', onClick);
  }, []);

  const filtered = useMemo(() => {
    let list = clients;
    if (dateFrom || dateTo) list = list.filter((c) => isDateInRange(c.created_at, dateFrom, dateTo));
    if (gender) list = list.filter((c) => c.gender === gender);
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((c) => {
        const code = patientCode(c.id);
        return (
          String(c.id).includes(term) ||
          code.includes(term) ||
          `${c.first_name} ${c.last_name}`.toLowerCase().includes(term) ||
          (c.phone || '').includes(term)
        );
      });
    }
    return [...list].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
  }, [clients, search, dateFrom, dateTo, gender]);

  function latestStatusFor(clientId: number): string | null {
    const patientVisits = visits.filter((v) => v.patient_id === clientId);
    if (patientVisits.length === 0) return null;
    return [...patientVisits].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]
      .status;
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('reports.title', 'Master Patient Directory & Reports')}</h1>
          <p style={{ color: 'var(--muted)' }}>
            {t('reports.subtitle', 'Complete laboratory history for all registered patients')}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder={t('dashboard.search_placeholder', 'Search Patient ID, Name, Phone...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 140 }}>
            <label style={filterLabelStyle}>{t('filters.from_date', 'From Date')}</label>
            <input
              type="date"
              style={filterInputStyle}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div style={{ width: 140 }}>
            <label style={filterLabelStyle}>{t('filters.to_date', 'To Date')}</label>
            <input
              type="date"
              style={filterInputStyle}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label style={filterLabelStyle}>{t('filters.gender', 'Gender')}</label>
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">{t('filters.all_genders', 'All Genders')}</option>
            <option value="Male">{t('filters.male', 'Male')}</option>
            <option value="Female">{t('filters.female', 'Female')}</option>
          </select>
        </div>
      </div>

      {loadError ? (
        <div className="table-container">
          <table style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ textAlign: 'center', padding: 30, color: 'var(--warn)' }}>
                  Could not connect to database.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : filtered.length === 0 ? (
        <div className="table-container">
          <table style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                  {t('alerts.empty_no_patients_filtered', 'No patients found matching your filters.')}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>{t('reports.col_patient_id', 'Patient ID')}</th>
                <th>{t('reports.col_name', 'Name')}</th>
                <th>{t('reports.col_date_registered', 'Date Registered')}</th>
                <th>{t('reports.col_phone', 'Phone')}</th>
                <th>{t('filters.gender', 'Gender')}</th>
                <th>{t('reports.col_latest_status', 'Latest Status')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.col_action', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const latestStatus = latestStatusFor(c.id);
                const pill = latestStatus ? STATUS_PILLS[latestStatus] : undefined;
                const pillCls = pill?.cls ?? 'info';
                const pillText = pill ? t(pill.key, pill.fallback) : t('alerts.status_registered', 'Registered');
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{patientCode(c.id)}</strong>
                    </td>
                    <td>{`${c.first_name} ${c.last_name}`.toUpperCase()}</td>
                    <td style={{ color: 'var(--muted)' }}>
                      {c.created_at ? window.formatCairoDateTime(c.created_at, false) : 'N/A'}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{c.phone || 'N/A'}</td>
                    <td>
                      <span className="pill ghost">{c.gender}</span>
                    </td>
                    <td>
                      <span className={`pill ${pillCls}`}>{pillText}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ borderColor: 'var(--teal)', color: 'var(--teal)' }}
                        onClick={() => window.openPatientHistoryModal(c.id)}
                      >
                        🔍 {t('reports.view_details', 'View Details')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
