import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { PaginationControls } from '../../lib/PaginationControls';

interface ActivityEntry {
  timestamp?: string;
  username?: string;
  event_type?: string;
  resource?: string;
  resource_id?: string | number;
  description?: string;
  status?: string;
  ip_address?: string;
}

interface ActivityResponse {
  items: ActivityEntry[];
  page: number;
  per_page: number;
  total_pages: number;
  total: number;
}

interface OnlineUser {
  username: string;
  last_seen_seconds_ago: number;
}

const EMPTY: ActivityResponse = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };

const filterInputStyle: CSSProperties = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
};

// Neither the option labels nor the table's event pill labels were ever wrapped in t()/
// data-i18n in the original (script_lab.js:8666-8672, index_lab.html) — kept literal here
// for a faithful port rather than introducing translation coverage that didn't exist before.
const EVENT_OPTIONS = [
  { value: '', label: 'All Events' },
  { value: 'login', label: 'Login' },
  { value: 'login_failed', label: 'Failed Login' },
  { value: 'logout', label: 'Logout' },
  { value: 'view', label: 'View' },
  { value: 'create', label: 'Create' },
  { value: 'update', label: 'Update' },
  { value: 'delete', label: 'Delete' },
];

function eventPillClass(eventType?: string) {
  if (eventType === 'login' || eventType === 'create') return 'ok';
  if (eventType === 'login_failed' || eventType === 'delete') return 'danger';
  if (eventType === 'update') return 'warn';
  if (eventType === 'view') return 'info';
  return 'ghost';
}

function eventLabel(eventType?: string) {
  const labels: Record<string, string> = {
    login: 'Login',
    login_failed: 'Failed Login',
    logout: 'Logout',
    view: 'View',
    create: 'Create',
    update: 'Update',
    delete: 'Delete',
  };
  return (eventType && labels[eventType]) || eventType || 'Unknown';
}

export default function ActivityLogTab() {
  const { t } = useTranslations();

  // Both /api/activity and /api/activity/online are @admin_required, and once the online-
  // users poll starts it never stops (script_lab.js's startOnlineUsersPolling() has no
  // matching stop) — so unlike Price Check/Statistics, mounting once and fetching
  // immediately would leave every non-admin session running a permanent background
  // 403-retry timer it can never see. Gate everything behind the tab actually being opened,
  // same as the original only ever calling loadActivityLog() from showTab()'s switch.
  const [activated, setActivated] = useState(
    () => document.getElementById('activity-log')?.classList.contains('active') ?? false
  );

  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '', username: '', eventType: '' });
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [data, setData] = useState<ActivityResponse>(EMPTY);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [usernames, setUsernames] = useState<string[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);

  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="activity-log"]');
    const onClick = () => {
      setActivated(true);
      setPage(1);
      setRefreshTick((n) => n + 1);
    };
    tabButton?.addEventListener('click', onClick);
    return () => tabButton?.removeEventListener('click', onClick);
  }, []);

  // Username filter options — populated once, from /api/users (already admin-only), same
  // as populateActivityUsernameFilter()'s activityUsernameOptionsLoaded guard.
  useEffect(() => {
    if (!activated || usernames.length > 0) return;
    apiFetch('/api/users')
      .then((res) => (res.ok ? (res.json() as Promise<{ username: string }[]>) : null))
      .then((users) => {
        if (users) setUsernames(users.map((u) => u.username));
      })
      .catch((err) => console.error('Failed to load users for activity filter', err));
  }, [activated, usernames.length]);

  useEffect(() => {
    if (!activated) return;
    const params = new URLSearchParams({ page: String(page), per_page: '100' });
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.username) params.set('username', filters.username);
    if (filters.eventType) params.set('event_type', filters.eventType);

    let cancelled = false;
    apiFetch(`/api/activity?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<ActivityResponse>) : null))
      .then((json) => {
        if (cancelled || !json) return;
        setData(json);
        setSelected(new Set()); // a fresh page/filter result always starts unselected
      })
      .catch((err) => console.error('Failed to load activity log', err));
    return () => {
      cancelled = true;
    };
  }, [activated, filters, page, refreshTick]);

  useEffect(() => {
    if (!activated) return;
    function poll() {
      apiFetch('/api/activity/online')
        .then((res) => (res.ok ? (res.json() as Promise<OnlineUser[]>) : null))
        .then((users) => {
          if (users) setOnlineUsers(users);
        })
        .catch((err) => console.error('Failed to load online users', err));
    }
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [activated]);

  function updateFilter(patch: Partial<typeof filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1); // any filter/search change goes back to page 1 - matches searchActivityLog()
  }

  function toggleRow(index: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(data.items.map((_, i) => i)) : new Set());
  }

  // Exports only the checked rows; if none are checked, falls back to exporting every row on
  // the current page — same "export what I'm looking at" fallback as the original.
  function exportSelected() {
    const items =
      selected.size > 0 ? [...selected].sort((a, b) => a - b).map((i) => data.items[i]) : data.items;
    if (items.length === 0) {
      window.showAlert(t('alerts.no_activity_to_export', 'No activity rows to export.'), 'error');
      return;
    }
    const headers = ['Timestamp', 'User', 'Event', 'Resource', 'Resource ID', 'Description', 'Status', 'IP'];
    const sheetData = [
      headers,
      ...items.map((entry) => [
        entry.timestamp || '',
        entry.username || '',
        eventLabel(entry.event_type),
        entry.resource || '',
        entry.resource_id || '',
        entry.description || '',
        entry.status || '',
        entry.ip_address || '',
      ]),
    ];
    const worksheet = window.XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    window.XLSX.writeFile(workbook, 'activity_log.xlsx');
  }

  const startIndex = (data.page - 1) * (data.per_page || 100);
  const allChecked = data.items.length > 0 && selected.size === data.items.length;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>{t('activity.title', 'Activity Log')}</h1>
          <p style={{ color: 'var(--muted)' }}>
            {t('activity.subtitle', 'Every login, action, and page view across the system')}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h3
          style={{
            color: 'var(--muted)',
            marginBottom: 10,
            fontSize: 14,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {t('activity.online_now', 'Online Now')}
        </h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {onlineUsers.length === 0 ? (
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>No one online right now.</span>
          ) : (
            onlineUsers.map((u) => (
              <span key={u.username} className="pill ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                🟢 {u.username}{' '}
                <span style={{ color: 'var(--muted)', fontSize: 10 }}>{u.last_seen_seconds_ago}s ago</span>
              </span>
            ))
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input
            type="text"
            placeholder="Search description, user, resource..."
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
              style={filterInputStyle}
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
              style={filterInputStyle}
              value={filters.dateTo}
              onChange={(e) => updateFilter({ dateTo: e.target.value })}
            />
          </div>
        </div>
        <div style={{ width: 170 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            User
          </label>
          <select style={filterInputStyle} value={filters.username} onChange={(e) => updateFilter({ username: e.target.value })}>
            <option value="">All Users</option>
            {usernames.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 150 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
            Event
          </label>
          <select style={filterInputStyle} value={filters.eventType} onChange={(e) => updateFilter({ eventType: e.target.value })}>
            {EVENT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          className="btn ghost"
          style={{ borderColor: 'var(--ok)', color: 'var(--ok)', fontSize: 12, padding: '4px 10px' }}
          onClick={exportSelected}
          title="Exports only the checked rows; exports everything on the current page if none are checked"
        >
          📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
              </th>
              <th>#</th>
              <th>Timestamp</th>
              <th>User</th>
              <th>Event</th>
              <th>Resource</th>
              <th>Description</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                  {t('alerts.empty_no_activity', 'No activity recorded yet.')}
                </td>
              </tr>
            ) : (
              data.items.map((entry, index) => (
                <tr key={startIndex + index}>
                  <td>
                    <input type="checkbox" checked={selected.has(index)} onChange={(e) => toggleRow(index, e.target.checked)} />
                  </td>
                  <td>{startIndex + index + 1}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {window.formatCairoDateTime(entry.timestamp) || ''}
                  </td>
                  <td>{entry.username || '—'}</td>
                  <td>
                    <span className={`pill ${eventPillClass(entry.event_type)}`}>{eventLabel(entry.event_type)}</span>
                  </td>
                  <td>
                    {entry.resource || ''}
                    {entry.resource_id ? ` #${entry.resource_id}` : ''}
                  </td>
                  <td>{entry.description || ''}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 11 }}>{entry.ip_address || ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <PaginationControls state={data} onPageChange={setPage} />
    </>
  );
}
