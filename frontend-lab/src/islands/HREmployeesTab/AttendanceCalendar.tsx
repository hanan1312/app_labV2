import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '../../lib/apiFetch';

type CalendarView = 'day' | 'week' | 'month';

interface TrendPoint {
  date: string;
  worked_hours: number;
  expected_hours: number;
  percentage: number;
}

interface SessionRow {
  id: number;
  clock_in: string;
  clock_out: string | null;
}

function cairoDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date);
}

// Jira-Tempo-style heatmap of hours worked (day/week/month views) — fully independent of the
// modal's own top range picker (see AttendanceDrillDownModal): it maintains its own
// view/refDate and only ever calls window.attendancePresetRange() seeded off refDate, same as
// the vanilla loadEamCalendar()/renderEamCalendar() (script_lab.js).
export default function AttendanceCalendar({ empId, open }: { empId: number; open: boolean }) {
  const [view, setView] = useState<CalendarView>('month');
  const [refDate, setRefDate] = useState<string>(() => cairoDateStr());
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [daySessions, setDaySessions] = useState<SessionRow[]>([]);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [bestPracticeOpen, setBestPracticeOpen] = useState(false);

  // Every fresh "Manage" click resets the calendar to month/today, same as the vanilla
  // openEmployeeAttendanceModal() — this effect re-fires on every open->true transition
  // (including re-opening the same employee), not just when empId changes.
  useEffect(() => {
    if (!open) return;
    setView('month');
    setRefDate(cairoDateStr());
    setBestPracticeOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, empId]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const { from, to } = window.attendancePresetRange(view === 'day' ? 'today' : view, refDate);
      setRange({ from, to });
      try {
        const requests = [apiFetch(`/api/hr/employees/${empId}/attendance/trend?from=${from}&to=${to}`)];
        if (view === 'day') {
          requests.push(apiFetch(`/api/hr/employees/${empId}/attendance/sessions?from=${from}&to=${to}`));
        }
        const [trendRes, sessionsRes] = await Promise.all(requests);
        setTrend(trendRes.ok ? await trendRes.json() : []);
        setDaySessions(sessionsRes && sessionsRes.ok ? await sessionsRes.json() : []);
      } catch (err) {
        console.error('Failed to load calendar', err);
      }
    })();
  }, [open, empId, view, refDate]);

  function shift(direction: 1 | -1) {
    const [y, m, d] = refDate.split('-').map(Number);
    let newMs: number;
    if (view === 'month') newMs = Date.UTC(y, m - 1 + direction, 1);
    else if (view === 'week') newMs = Date.UTC(y, m - 1, d + direction * 7);
    else newMs = Date.UTC(y, m - 1, d + direction);
    setRefDate(new Date(newMs).toISOString().slice(0, 10));
  }

  function viewDay(dateStr: string) {
    setView('day');
    setRefDate(dateStr);
  }

  const byDate: Record<string, TrendPoint> = {};
  trend.forEach((t) => {
    byDate[t.date] = t;
  });

  let label = '';
  if (range.from) {
    if (view === 'month') {
      const [y, m] = range.from.split('-').map(Number);
      label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } else if (view === 'week') {
      label = `${range.from} → ${range.to}`;
    } else {
      label = range.from;
    }
  }

  const viewBtnStyle = (v: CalendarView): CSSProperties =>
    v === view ? { padding: '6px 12px', background: 'var(--teal)', color: '#04121d' } : { padding: '6px 12px' };

  return (
    <>
      <h4 style={{ color: 'var(--muted)', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 5, margin: '20px 0 10px 0' }}>
        Calendar
      </h4>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn ghost" style={{ padding: '6px 10px' }} onClick={() => shift(-1)}>
            ◀
          </button>
          <strong style={{ minWidth: 160, textAlign: 'center', display: 'inline-block' }}>{label}</strong>
          <button type="button" className="btn ghost" style={{ padding: '6px 10px' }} onClick={() => shift(1)}>
            ▶
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn ghost" style={viewBtnStyle('day')} onClick={() => setView('day')}>
            Day
          </button>
          <button type="button" className="btn ghost" style={viewBtnStyle('week')} onClick={() => setView('week')}>
            Week
          </button>
          <button type="button" className="btn ghost" style={viewBtnStyle('month')} onClick={() => setView('month')}>
            Month
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '6px 12px', background: 'var(--gold)', color: '#04121d' }}
            onClick={() => setBestPracticeOpen((v) => !v)}
          >
            💡 Best Practice
          </button>
        </div>
      </div>

      {bestPracticeOpen && (
        <div className="glass-panel" style={{ padding: 15, borderRadius: 8, marginBottom: 15, border: '1px dashed var(--gold)' }}>
          <h4 style={{ color: 'var(--gold)', marginBottom: 8 }}>💡 Attendance Best Practices</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
            <li>
              Keep a single continuous shift where possible — several short split sessions in one day usually signal a forgotten
              clock-out rather than an intentional schedule.
            </li>
            <li>Flag any session left open longer than ~12–16 hours for correction — it's almost always a missed clock-out, not real hours worked.</li>
            <li>Wait for at least a month of data before relying on the percentage for a performance conversation — a single bad week can skew a short window.</li>
            <li>
              Use "Excused Hours" for occasional lateness/early leave, and "Vacations" for planned multi-day leave — mixing the two
              makes the monthly percentage harder to read.
            </li>
            <li>Revisit the weekly-days-off policy each quarter — a mismatch between the configured day off and actual staffing patterns quietly drags every employee's percentage down.</li>
          </ul>
        </div>
      )}

      {view === 'day' ? (
        <>
          <div style={{ textAlign: 'center', padding: '15px 0' }}>
            <div style={{ fontSize: 32, fontWeight: 'bold', color: 'var(--teal)' }}>
              {(byDate[range.from]?.worked_hours ?? 0)}h
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              worked of {byDate[range.from]?.expected_hours ?? 0}h expected — {byDate[range.from]?.percentage ?? 0}%
            </div>
          </div>
          {daySessions.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>No sessions this day.</p>
          ) : (
            daySessions.map((s) => (
              <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                {window.formatCairoDateTime(s.clock_in)} → {s.clock_out ? window.formatCairoDateTime(s.clock_out) : 'Open'}
              </div>
            ))
          )}
        </>
      ) : (
        <CalendarGrid view={view} from={range.from} to={range.to} byDate={byDate} onDayClick={viewDay} />
      )}
    </>
  );
}

function CalendarGrid({
  view,
  from,
  to,
  byDate,
  onDayClick,
}: {
  view: CalendarView;
  from: string;
  to: string;
  byDate: Record<string, TrendPoint>;
  onDayClick: (dateStr: string) => void;
}) {
  if (!from || !to) return null;

  const startWeekday = view === 'month' ? (new Date(from + 'T00:00:00Z').getUTCDay() + 6) % 7 : 0;
  const cells: (string | null)[] = Array(startWeekday).fill(null);
  for (let ms = new Date(from + 'T00:00:00Z').getTime(); ms <= new Date(to + 'T00:00:00Z').getTime(); ms += 86400000) {
    cells.push(new Date(ms).toISOString().slice(0, 10));
  }

  const maxHours = Math.max(1, ...Object.values(byDate).map((t) => t.worked_hours));
  const today = cairoDateStr();

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
        <div>Mon</div>
        <div>Tue</div>
        <div>Wed</div>
        <div>Thu</div>
        <div>Fri</div>
        <div>Sat</div>
        <div>Sun</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={i} />;
          const t = byDate[dateStr] || { worked_hours: 0, expected_hours: 0, percentage: 0 };
          const intensity = Math.min(1, t.worked_hours / maxHours);
          const bg = t.worked_hours > 0 ? `rgba(92, 209, 163, ${0.12 + intensity * 0.55})` : 'rgba(128,128,128,0.06)';
          const dayNum = parseInt(dateStr.slice(8, 10), 10);
          const isToday = dateStr === today;
          return (
            <div
              key={dateStr}
              onClick={() => onDayClick(dateStr)}
              title={dateStr}
              style={{
                background: bg,
                borderRadius: 6,
                padding: 8,
                minHeight: view === 'month' ? 56 : 80,
                cursor: 'pointer',
                border: `1px solid ${isToday ? 'var(--teal)' : 'transparent'}`,
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dayNum}</div>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: 'var(--text)' }}>{t.worked_hours > 0 ? `${t.worked_hours}h` : ''}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
