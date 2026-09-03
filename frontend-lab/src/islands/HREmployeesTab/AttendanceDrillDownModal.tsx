import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { Avatar } from '../../lib/Avatar';
import AttendanceCalendar from './AttendanceCalendar';

interface Employee {
  id: number;
  name: string;
  photo_path?: string;
}

interface Session {
  id: number;
  clock_in: string;
  clock_out: string | null;
  note: string | null;
  is_open: boolean;
}

interface PermissionRow {
  id: number;
  permission_date: string;
  start_time: string;
  end_time: string;
  credited_hours: number;
  reason: string | null;
}

interface VacationRow {
  id: number;
  start_date: string;
  end_date: string;
  reason: string | null;
}

interface PercentageData {
  percentage: number;
  worked_hours: number;
  credited_hours: number;
  expected_hours: number;
}

interface TrendPoint {
  date: string;
  worked_hours: number;
  expected_hours: number;
  percentage: number;
}

interface DateRange {
  from: string;
  to: string;
}

const EMPTY_SESSION_FORM = { clockIn: '', clockOut: '', note: '' };
const EMPTY_PERMISSION_FORM = { date: '', start: '', end: '', reason: '' };
const EMPTY_VACATION_FORM = { start: '', end: '', reason: '' };

const smallLabel: CSSProperties = { fontSize: 11, color: 'var(--muted)', display: 'block' };

export default function AttendanceDrillDownModal({
  open,
  empId,
  employees,
  onClose,
  onMutated,
}: {
  open: boolean;
  empId: number | null;
  employees: Employee[];
  onClose: () => void;
  // Sessions/vacations (but not permissions — same asymmetry as the vanilla original) affect
  // the main employee list's "clocked in" / "on vacation" status badges, so those mutations
  // ask HREmployeesTab to refetch its own list too.
  onMutated: () => void;
}) {
  const { t } = useTranslations();
  const emp = empId != null ? employees.find((e) => e.id === empId) : undefined;

  // Persists across opens/closes and across different employees — same as the vanilla
  // #att-eam-from/#att-eam-to inputs, which are never reset except by explicit user action.
  const [range, setRange] = useState<DateRange>(() => window.attendancePresetRange('month'));
  const [rangeInputs, setRangeInputs] = useState<DateRange>(range);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [vacations, setVacations] = useState<VacationRow[]>([]);
  const [percentage, setPercentage] = useState<PercentageData | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [sessionForm, setSessionForm] = useState(EMPTY_SESSION_FORM);
  const [permissionForm, setPermissionForm] = useState(EMPTY_PERMISSION_FORM);
  const [vacationForm, setVacationForm] = useState(EMPTY_VACATION_FORM);

  async function refetchAll(r: DateRange) {
    if (empId == null) return;
    try {
      const params = new URLSearchParams();
      if (r.from) params.set('from', r.from);
      if (r.to) params.set('to', r.to);
      const query = params.toString();
      const [sessionsRes, permissionsRes, vacationsRes, percentageRes, trendRes] = await Promise.all([
        apiFetch(`/api/hr/employees/${empId}/attendance/sessions?${query}`),
        apiFetch(`/api/hr/employees/${empId}/attendance/permissions`),
        apiFetch(`/api/hr/employees/${empId}/attendance/vacations`),
        apiFetch(`/api/hr/employees/${empId}/attendance/percentage?${query}`),
        apiFetch(`/api/hr/employees/${empId}/attendance/trend?${query}`),
      ]);
      setSessions(sessionsRes.ok ? await sessionsRes.json() : []);
      setPermissions(permissionsRes.ok ? await permissionsRes.json() : []);
      setVacations(vacationsRes.ok ? await vacationsRes.json() : []);
      setPercentage(percentageRes.ok ? await percentageRes.json() : null);
      setTrend(trendRes.ok ? await trendRes.json() : []);
    } catch (err) {
      console.error('Failed to load employee attendance data', err);
    }
  }

  // Every fresh "Manage" click resets editing state (but NOT the add-forms or the shared date
  // range — same as the vanilla openEmployeeAttendanceModal(), which only clears
  // eamEditingSessionId, never the raw form input values).
  useEffect(() => {
    if (!open || empId == null) return;
    setEditingSessionId(null);
    setRangeInputs(range);
    refetchAll(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, empId]);

  function applyPreset(preset: string) {
    if (!preset) return;
    const next = window.attendancePresetRange(preset as 'today' | 'week' | 'month' | 'year');
    setRange(next);
    setRangeInputs(next);
    refetchAll(next);
  }

  function startEditSession(row: Session) {
    setEditingSessionId(row.id);
    setSessionForm({
      clockIn: row.clock_in.replace(' ', 'T').slice(0, 16),
      clockOut: row.clock_out ? row.clock_out.replace(' ', 'T').slice(0, 16) : '',
      note: row.note || '',
    });
  }

  async function submitSession(e: FormEvent) {
    e.preventDefault();
    if (empId == null) return;
    const toServerFormat = (v: string) => (v ? v.replace('T', ' ') : '');
    const payload = { clock_in: toServerFormat(sessionForm.clockIn), clock_out: toServerFormat(sessionForm.clockOut), note: sessionForm.note };
    const isEdit = editingSessionId != null;
    const endpoint = isEdit ? `/api/hr/attendance/sessions/${editingSessionId}` : `/api/hr/employees/${empId}/attendance/sessions`;
    try {
      const res = await apiFetch(endpoint, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        window.showAlert(
          isEdit ? t('alerts.attendance_session_updated', 'Session updated.') : t('alerts.attendance_session_added', 'Session added.'),
          'success'
        );
        setEditingSessionId(null);
        setSessionForm(EMPTY_SESSION_FORM);
        await refetchAll(range);
        onMutated();
      } else {
        window.showAlert(data.error || t('alerts.attendance_session_save_failed', 'Failed to save session.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.attendance_session_save_network_error', 'Network error saving session.'), 'error');
    }
  }

  async function deleteSession(id: number) {
    if (!window.confirm(t('alerts.confirm_delete_session', 'Delete this session?'))) return;
    try {
      const res = await apiFetch(`/api/hr/attendance/sessions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await refetchAll(range);
        onMutated();
      }
    } catch {
      window.showAlert(t('alerts.attendance_session_delete_error', 'Error deleting session.'), 'error');
    }
  }

  async function submitPermission(e: FormEvent) {
    e.preventDefault();
    if (empId == null) return;
    const payload = {
      permission_date: permissionForm.date,
      start_time: permissionForm.start,
      end_time: permissionForm.end,
      reason: permissionForm.reason,
    };
    try {
      const res = await apiFetch(`/api/hr/employees/${empId}/attendance/permissions`, { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        window.showAlert(t('alerts.attendance_excused_recorded', 'Excused hours recorded.'), 'success');
        setPermissionForm(EMPTY_PERMISSION_FORM);
        await refetchAll(range);
      } else {
        window.showAlert(data.error || t('alerts.attendance_excused_failed', 'Failed to record excused hours.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.attendance_excused_network_error', 'Network error recording excused hours.'), 'error');
    }
  }

  async function deletePermission(id: number) {
    if (!window.confirm(t('alerts.confirm_delete_entry', 'Delete this entry?'))) return;
    try {
      const res = await apiFetch(`/api/hr/attendance/permissions/${id}`, { method: 'DELETE' });
      if (res.ok) await refetchAll(range);
    } catch {
      window.showAlert(t('alerts.attendance_entry_delete_error', 'Error deleting entry.'), 'error');
    }
  }

  async function submitVacation(e: FormEvent) {
    e.preventDefault();
    if (empId == null) return;
    const payload = { start_date: vacationForm.start, end_date: vacationForm.end, reason: vacationForm.reason };
    try {
      const res = await apiFetch(`/api/hr/employees/${empId}/attendance/vacations`, { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        window.showAlert(t('alerts.vacation_added', 'Vacation added.'), 'success');
        setVacationForm(EMPTY_VACATION_FORM);
        await refetchAll(range);
        onMutated();
      } else {
        window.showAlert(data.error || t('alerts.vacation_add_failed', 'Failed to add vacation.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.vacation_add_network_error', 'Network error adding vacation.'), 'error');
    }
  }

  async function deleteVacation(id: number) {
    if (!window.confirm(t('alerts.confirm_delete_vacation', 'Delete this vacation?'))) return;
    try {
      const res = await apiFetch(`/api/hr/attendance/vacations/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await refetchAll(range);
        onMutated();
      }
    } catch {
      window.showAlert(t('alerts.vacation_delete_error', 'Error deleting vacation.'), 'error');
    }
  }

  return (
    <div id="employee-attendance-modal" className="modal" style={{ display: open ? 'block' : 'none' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 800, maxHeight: '85vh', overflowY: 'auto' }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {emp && <Avatar photoPath={emp.photo_path} name={emp.name} size={40} />}
          <span>
            Attendance — <span>{emp?.name || ''}</span>
          </span>
        </h2>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '15px 0' }}>
          <input
            type="date"
            style={{ padding: 6 }}
            value={rangeInputs.from}
            onChange={(e) => setRangeInputs((r) => ({ ...r, from: e.target.value }))}
          />
          <input
            type="date"
            style={{ padding: 6 }}
            value={rangeInputs.to}
            onChange={(e) => setRangeInputs((r) => ({ ...r, to: e.target.value }))}
          />
          <select style={{ padding: 6 }} defaultValue="month" onChange={(e) => applyPreset(e.target.value)}>
            <option value="">Quick range…</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="year">This Year</option>
          </select>
          <button
            className="btn ghost"
            style={{ padding: '6px 12px' }}
            onClick={() => {
              setRange(rangeInputs);
              refetchAll(rangeInputs);
            }}
          >
            🔎
          </button>
        </div>

        {percentage && <PercentageCard data={percentage} />}

        <h4 style={{ color: 'var(--muted)', marginBottom: 10 }}>Attendance Performance</h4>
        <div style={{ height: 220, marginBottom: 25 }}>
          <TrendChart trend={trend} />
        </div>

        <h4 style={{ color: 'var(--muted)', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 5, marginBottom: 10 }}>
          Sessions
        </h4>
        <form onSubmit={submitSession} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
          <div>
            <label style={smallLabel}>Clock In</label>
            <input
              type="datetime-local"
              required
              value={sessionForm.clockIn}
              onChange={(e) => setSessionForm((f) => ({ ...f, clockIn: e.target.value }))}
            />
          </div>
          <div>
            <label style={smallLabel}>Clock Out</label>
            <input
              type="datetime-local"
              value={sessionForm.clockOut}
              onChange={(e) => setSessionForm((f) => ({ ...f, clockOut: e.target.value }))}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={smallLabel}>Note</label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={sessionForm.note}
              onChange={(e) => setSessionForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>
          <button type="submit" className="btn ghost">
            + Add
          </button>
        </form>
        <div style={{ marginBottom: 25 }}>
          {sessions.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>No sessions found.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th>Hours</th>
                    <th>Status</th>
                    <th>Note</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const durationHours = s.clock_out
                      ? ((new Date(s.clock_out.replace(' ', 'T')).getTime() - new Date(s.clock_in.replace(' ', 'T')).getTime()) / 3600000).toFixed(2)
                      : '—';
                    return (
                      <tr key={s.id}>
                        <td>{window.formatCairoDateTime(s.clock_in)}</td>
                        <td>{s.clock_out ? window.formatCairoDateTime(s.clock_out) : '—'}</td>
                        <td>{durationHours}</td>
                        <td>{s.is_open ? <span className="pill warn">Open</span> : <span className="pill ok">Closed</span>}</td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>{s.note || ''}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button type="button" className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEditSession(s)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }}
                            onClick={() => deleteSession(s.id)}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <h4 style={{ color: 'var(--muted)', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 5, marginBottom: 10 }}>
          Excused Hours (Permissions)
        </h4>
        <form onSubmit={submitPermission} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
          <div>
            <label style={smallLabel}>Date</label>
            <input type="date" required value={permissionForm.date} onChange={(e) => setPermissionForm((f) => ({ ...f, date: e.target.value }))} />
          </div>
          <div>
            <label style={smallLabel}>Start</label>
            <input type="time" required value={permissionForm.start} onChange={(e) => setPermissionForm((f) => ({ ...f, start: e.target.value }))} />
          </div>
          <div>
            <label style={smallLabel}>End</label>
            <input type="time" required value={permissionForm.end} onChange={(e) => setPermissionForm((f) => ({ ...f, end: e.target.value }))} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={smallLabel}>Reason</label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={permissionForm.reason}
              onChange={(e) => setPermissionForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          <button type="submit" className="btn ghost">
            + Add
          </button>
        </form>
        <div style={{ marginBottom: 25 }}>
          {permissions.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>No excused-hours entries.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Hours</th>
                    <th>Reason</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {permissions.map((p) => (
                    <tr key={p.id}>
                      <td>{p.permission_date}</td>
                      <td>
                        {p.start_time} - {p.end_time}
                      </td>
                      <td>{p.credited_hours}h</td>
                      <td>{p.reason || ''}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }}
                          onClick={() => deletePermission(p.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <h4 style={{ color: 'var(--muted)', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 5, marginBottom: 10 }}>
          Vacations
        </h4>
        <form onSubmit={submitVacation} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
          <div>
            <label style={smallLabel}>From</label>
            <input type="date" required value={vacationForm.start} onChange={(e) => setVacationForm((f) => ({ ...f, start: e.target.value }))} />
          </div>
          <div>
            <label style={smallLabel}>To</label>
            <input type="date" required value={vacationForm.end} onChange={(e) => setVacationForm((f) => ({ ...f, end: e.target.value }))} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={smallLabel}>Reason</label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={vacationForm.reason}
              onChange={(e) => setVacationForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          <button type="submit" className="btn ghost">
            + Add
          </button>
        </form>
        <div>
          {vacations.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>No vacations recorded.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Dates</th>
                    <th>Reason</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {vacations.map((v) => (
                    <tr key={v.id}>
                      <td>
                        {v.start_date} → {v.end_date}
                      </td>
                      <td>{v.reason || ''}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }}
                          onClick={() => deleteVacation(v.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {empId != null && <AttendanceCalendar empId={empId} open={open} />}
      </div>
    </div>
  );
}

function PercentageCard({ data }: { data: PercentageData }) {
  const pctColor = data.percentage >= 90 ? 'var(--ok)' : data.percentage >= 70 ? 'var(--warn)' : 'var(--danger)';
  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Attendance %</div>
        <div style={{ fontSize: 30, fontWeight: 'bold', color: pctColor }}>{data.percentage}%</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Worked</div>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: 'var(--text)' }}>{data.worked_hours}h</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Credited</div>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: 'var(--text)' }}>{data.credited_hours}h</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Expected</div>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: 'var(--text)' }}>{data.expected_hours}h</div>
      </div>
    </div>
  );
}

// Reads the app's own theme tokens so the chart matches dark/light mode automatically instead
// of hardcoding colors that would clash if the user toggles theme — same as the vanilla
// renderEamTrendChart(). Destroys the previous Chart.js instance before creating a new one
// (required to avoid canvas-reuse errors) via the same ref-based pattern its own cleanup
// (closeEmployeeAttendanceModal) used; here that's just the effect's own cleanup function.
function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.Chart === 'undefined') return;

    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const style = getComputedStyle(document.documentElement);
    const teal = style.getPropertyValue('--teal').trim() || '#5cbdb9';
    const muted = style.getPropertyValue('--muted').trim() || '#8aa6b8';
    const border = style.getPropertyValue('--border').trim() || 'rgba(255,255,255,.07)';

    const dense = trend.length > 45; // hide point markers when the range is long (e.g. a year)
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartRef.current = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.date.slice(5)), // MM-DD, compact
        datasets: [
          {
            label: 'Attendance %',
            data: trend.map((t) => t.percentage),
            borderColor: teal,
            backgroundColor: teal + '26', // ~15% alpha fill under the line
            borderWidth: 2,
            pointRadius: dense ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: teal,
            tension: 0.25,
            fill: true,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }, // single series - the section title already names it
          tooltip: {
            callbacks: {
              title: (items: { dataIndex: number }[]) => trend[items[0].dataIndex].date,
              label: (item: { dataIndex: number }) => {
                const t = trend[item.dataIndex];
                return [`Attendance: ${t.percentage}%`, `Worked: ${t.worked_hours}h`, `Expected: ${t.expected_hours}h`];
              },
            },
          },
        },
        scales: {
          y: {
            min: 0,
            max: 100,
            ticks: { color: muted, callback: (v: number) => v + '%' },
            grid: { color: border },
          },
          x: {
            ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
            grid: { display: false },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [trend]);

  return <canvas ref={canvasRef} />;
}
