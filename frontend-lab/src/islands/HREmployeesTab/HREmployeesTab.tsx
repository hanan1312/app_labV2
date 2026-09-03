import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { Avatar } from '../../lib/Avatar';
import AttendanceDrillDownModal from './AttendanceDrillDownModal';

interface Employee {
  id: number;
  name: string;
  role: string;
  phone?: string;
  email?: string;
  salary: number | string;
  username?: string;
  photo_path?: string;
  join_date?: string;
  presence_status?: 'online' | 'idle' | 'offline';
  attendance_status?: { clocked_in: boolean; since: string | null; on_vacation: boolean };
}

interface ModalState {
  open: boolean;
  editingId: number | null;
  name: string;
  role: string;
  phone: string;
  salary: string;
  email: string;
  joinDate: string;
  username: string;
  photoPath: string;
}

const CLOSED_MODAL: ModalState = {
  open: false,
  editingId: null,
  name: '',
  role: 'Pathologist',
  phone: '',
  salary: '',
  email: '',
  joinDate: '',
  username: '',
  photoPath: '',
};

const filterSelectStyle: CSSProperties = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
};

interface Holiday {
  id: number;
  date: string;
  name: string;
}

interface AttendanceConfig {
  weekly_days_off: number[];
  standard_work_hours_per_day: number;
  holidays: Holiday[];
}

const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = { weekly_days_off: [], standard_work_hours_per_day: 8, holidays: [] };
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface PercentageRow {
  employee_id: number;
  name: string;
  role?: string;
  worked_hours: number;
  credited_hours: number;
  expected_hours: number;
  percentage: number;
}

interface DateRange {
  from: string;
  to: string;
}

export default function HREmployeesTab() {
  const { t } = useTranslations();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [presenceFilter, setPresenceFilter] = useState('');
  const [attendanceFilter, setAttendanceFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<ModalState>(CLOSED_MODAL);
  const [listContainer, setListContainer] = useState<HTMLElement | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const [policyContainer, setPolicyContainer] = useState<HTMLElement | null>(null);
  const [attendanceConfig, setAttendanceConfig] = useState<AttendanceConfig>(DEFAULT_ATTENDANCE_CONFIG);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });

  const [reportContainer, setReportContainer] = useState<HTMLElement | null>(null);
  const [reportRange, setReportRange] = useState<DateRange>(() => window.attendancePresetRange('month'));
  const [reportRows, setReportRows] = useState<PercentageRow[]>([]);

  const [drillDown, setDrillDown] = useState<{ open: boolean; empId: number | null }>({ open: false, empId: null });

  async function refetch() {
    try {
      const res = await apiFetch('/api/hr/employees');
      if (!res.ok) throw new Error('Failed to fetch employees');
      setEmployees(await res.json());
      setLoadError(false);
    } catch (err) {
      console.error('Failed to load HR data', err);
      setLoadError(true);
    }
  }

  async function refetchAttendanceConfig() {
    try {
      const res = await apiFetch('/api/hr/attendance/config');
      if (res.ok) setAttendanceConfig(await res.json());
    } catch (err) {
      console.error('Failed to load attendance config', err);
    }
  }

  async function refetchReport(range: DateRange) {
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      const res = await apiFetch(`/api/hr/attendance/percentage?${params.toString()}`);
      if (!res.ok) return;
      const rows: PercentageRow[] = await res.json();
      setReportRows(rows.slice().sort((a, b) => a.percentage - b.percentage));
    } catch (err) {
      console.error('Failed to load attendance percentage report', err);
    }
  }

  useEffect(() => {
    // #hr-list-container / #hr-attendance-policy-root / #hr-attendance-report-root are plain,
    // already-present empty <div>s in the vanilla HTML — each section is portaled into its own
    // so this one component/state can span all three despite the unrelated Security Policies
    // panel sitting between the header and the rest (see the comment on that panel in
    // index_lab.html — generic settings, not HR-specific, and must stay exactly where it is).
    setListContainer(document.getElementById('hr-list-container'));
    setPolicyContainer(document.getElementById('hr-attendance-policy-root'));
    setReportContainer(document.getElementById('hr-attendance-report-root'));
    refetch();
    refetchAttendanceConfig();
    refetchReport(reportRange);
    // Only ever want this to run once, on mount — reportRange changing later (preset picker,
    // manual edit) is applied explicitly via the 🔎 button/preset onChange, not automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Mirrors the vanilla setInterval(..., 10000) that used to poll fetchHRData() while
    // #hr-management was the active tab (script_lab.js) — that vanilla poller (and
    // fetchHRData() itself) is now gone: this was its only remaining reason to exist, since
    // everything else in this tab is React-owned.
    const id = setInterval(() => {
      if (document.getElementById('hr-management')?.classList.contains('active')) {
        refetch();
      }
    }, 10000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    let result = employees;
    if (presenceFilter) {
      result = result.filter((emp) => (emp.presence_status || 'offline') === presenceFilter);
    }
    if (attendanceFilter) {
      result = result.filter((emp) => {
        const att = emp.attendance_status || { clocked_in: false, on_vacation: false };
        if (attendanceFilter === 'vacation') return !!att.on_vacation;
        if (attendanceFilter === 'in') return att.clocked_in && !att.on_vacation;
        if (attendanceFilter === 'out') return !att.clocked_in && !att.on_vacation;
        return true;
      });
    }
    return result;
  }, [employees, presenceFilter, attendanceFilter]);

  function openAddModal() {
    setModal({ ...CLOSED_MODAL, open: true });
  }

  function openEditModal(emp: Employee) {
    setModal({
      open: true,
      editingId: emp.id,
      name: emp.name,
      role: emp.role,
      phone: emp.phone || '',
      salary: String(emp.salary ?? ''),
      email: emp.email || '',
      joinDate: emp.join_date || '',
      username: emp.username || '',
      photoPath: emp.photo_path || '',
    });
  }

  function closeModal() {
    setModal(CLOSED_MODAL);
  }

  function handlePhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setModal((m) => ({ ...m, photoPath: String(ev.target?.result || '') }));
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      id: modal.editingId || undefined,
      name: modal.name,
      role: modal.role,
      phone: modal.phone,
      salary: modal.salary,
      email: modal.email,
      join_date: modal.joinDate,
      username: modal.username,
      photo_path: modal.photoPath,
    };

    try {
      const res = await apiFetch('/api/hr/employees', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) {
        window.showAlert(t('alerts.hr_employee_saved', 'Employee saved successfully!'), 'success');
        closeModal();
        await refetch();
      } else {
        window.showAlert(t('alerts.hr_employee_save_failed', 'Failed to save employee.'), 'error');
      }
    } catch (err) {
      console.error(err);
      window.showAlert(t('alerts.hr_employee_save_error', 'Error saving employee data.'), 'error');
    }
  }

  function toggleSelect(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((emp) => emp.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_employees', 'Are you sure you want to delete {count} employee(s)? This cannot be undone.', { count: ids.length }))) {
      return;
    }
    try {
      let successCount = 0;
      for (const id of ids) {
        const res = await apiFetch(`/api/hr/employees/${id}`, { method: 'DELETE' });
        if (res.ok) successCount++;
      }
      window.showAlert(t('alerts.hr_employees_deleted', 'Successfully deleted {count} employees!', { count: successCount }), 'success');
      setSelectedIds(new Set());
      await refetch();
    } catch (err) {
      console.error(err);
      window.showAlert(t('alerts.hr_employees_delete_error', 'Error deleting employees.'), 'error');
    }
  }

  // Sends the same notification over both channels the app already has wired up: real SMTP
  // email via the Flask backend, and WhatsApp direct to the Node bot — same shape as the
  // vanilla handleBulkEmailHR().
  async function handleBulkEmail() {
    const recipients = [...selectedIds]
      .map((id) => employees.find((e) => e.id === id))
      .filter((e): e is Employee => !!e);
    if (recipients.length === 0) return;

    const emailRecipients = recipients.filter((r) => r.email && r.email !== 'null');
    const phoneRecipients = recipients.filter((r) => r.phone && r.phone !== 'null');

    if (emailRecipients.length === 0 && phoneRecipients.length === 0) {
      window.showAlert(t('alerts.hr_no_contact_info', 'None of the selected employees have an email or phone number saved.'), 'warn');
      return;
    }

    const subject = window.prompt(`Draft a notification for ${recipients.length} employee(s). Enter subject:`, 'Lab Notification');
    if (!subject) return;
    const message = window.prompt('Enter your message:');
    if (!message) return;

    let emailResultText: string;
    let emailFailed = false;
    if (emailRecipients.length > 0) {
      try {
        const res = await apiFetch('/api/hr/employees/email', {
          method: 'POST',
          body: JSON.stringify({ emails: emailRecipients.map((r) => r.email), subject, message }),
        });
        const body = await res.json();
        if (res.ok) {
          const hadPartialFailure = body.failed && body.failed.length;
          emailFailed = !!hadPartialFailure;
          emailResultText = `${t('alerts.hr_email_sent', 'Email: sent to {count}', { count: body.sent ?? emailRecipients.length })}${
            hadPartialFailure ? t('alerts.hr_email_failed_count', ', failed for {count}', { count: body.failed.length }) : ''
          }.`;
        } else {
          emailFailed = true;
          emailResultText = t('alerts.hr_email_failed_reason', 'Email: failed — {reason}.', {
            reason: body.error || t('alerts.hr_unknown_error', 'unknown error'),
          });
        }
      } catch {
        emailFailed = true;
        emailResultText = t('alerts.hr_email_failed_network', 'Email: failed — network error.');
      }
    } else {
      emailResultText = t('alerts.hr_email_skipped', 'Email: skipped (no addresses saved).');
    }

    let waSent = 0;
    let waFailed = 0;
    if (phoneRecipients.length > 0) {
      const nodeServer = `http://${window.location.hostname}:${window.APP_PORTS.node}`;
      for (const r of phoneRecipients) {
        try {
          const res = await fetch(`${nodeServer}/api/whatsapp/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ centerId: 'lab', phone: r.phone, message: `Hello ${r.name},\n\n${message}` }),
          });
          if (res.ok) waSent++;
          else waFailed++;
        } catch {
          waFailed++;
        }
      }
    }
    const waResultText =
      phoneRecipients.length === 0
        ? t('alerts.hr_whatsapp_skipped', 'WhatsApp: skipped (no phone numbers saved).')
        : `${t('alerts.hr_whatsapp_sent', 'WhatsApp: sent to {count}', { count: waSent })}${
            waFailed ? t('alerts.hr_whatsapp_failed_count', ', failed for {count}', { count: waFailed }) : ''
          }.`;

    window.showAlert(`${emailResultText} ${waResultText}`, emailFailed || waFailed > 0 ? 'error' : 'success');
    setSelectedIds(new Set());
  }

  async function clockIn(empId: number) {
    try {
      const res = await apiFetch(`/api/hr/employees/${empId}/attendance/clock-in`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) await refetch();
      else window.showAlert(data.error || t('alerts.attendance_clockin_failed', 'Failed to clock in.'), 'error');
    } catch {
      window.showAlert(t('alerts.attendance_clockin_network_error', 'Network error clocking in.'), 'error');
    }
  }

  async function clockOut(empId: number) {
    try {
      const res = await apiFetch(`/api/hr/employees/${empId}/attendance/clock-out`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) await refetch();
      else window.showAlert(data.error || t('alerts.attendance_clockout_failed', 'Failed to clock out.'), 'error');
    } catch {
      window.showAlert(t('alerts.attendance_clockout_network_error', 'Network error clocking out.'), 'error');
    }
  }

  function toggleWeeklyDayOff(day: number, checked: boolean) {
    setAttendanceConfig((c) => ({
      ...c,
      weekly_days_off: checked ? [...c.weekly_days_off, day] : c.weekly_days_off.filter((d) => d !== day),
    }));
  }

  async function handleSaveAttendanceConfig() {
    try {
      const res = await apiFetch('/api/hr/attendance/config', {
        method: 'POST',
        body: JSON.stringify({
          weekly_days_off: attendanceConfig.weekly_days_off,
          standard_work_hours_per_day: attendanceConfig.standard_work_hours_per_day,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        window.showAlert(t('alerts.attendance_policy_saved', 'Attendance policy saved.'), 'success');
        await refetchAttendanceConfig();
        await refetchReport(reportRange);
      } else {
        window.showAlert(data.error || t('alerts.attendance_policy_save_failed', 'Failed to save policy.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.attendance_policy_network_error', 'Network error saving policy.'), 'error');
    }
  }

  async function handleAddHoliday() {
    if (!newHoliday.date) {
      window.showAlert(t('alerts.pick_date_first', 'Pick a date first.'), 'error');
      return;
    }
    try {
      const res = await apiFetch('/api/hr/attendance/holidays', { method: 'POST', body: JSON.stringify(newHoliday) });
      const data = await res.json();
      if (res.ok) {
        setNewHoliday({ date: '', name: '' });
        await refetchAttendanceConfig();
        await refetchReport(reportRange);
      } else {
        window.showAlert(data.error || t('alerts.holiday_add_failed', 'Failed to add holiday.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.holiday_add_network_error', 'Network error adding holiday.'), 'error');
    }
  }

  async function handleDeleteHoliday(id: number) {
    if (!window.confirm(t('alerts.confirm_remove_holiday', 'Remove this holiday?'))) return;
    try {
      const res = await apiFetch(`/api/hr/attendance/holidays/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await refetchAttendanceConfig();
        await refetchReport(reportRange);
      }
    } catch {
      window.showAlert(t('alerts.holiday_remove_error', 'Error removing holiday.'), 'error');
    }
  }

  function handleReportPresetChange(preset: string) {
    if (!preset) return;
    const range = window.attendancePresetRange(preset as 'today' | 'week' | 'month' | 'year');
    setReportRange(range);
    refetchReport(range);
  }

  const allChecked = filtered.length > 0 && filtered.every((emp) => selectedIds.has(emp.id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 15, marginBottom: 24 }}>
        <div>
          <h1>{t('hr.title', 'HR & Staff Management')}</h1>
          <p style={{ color: 'var(--muted)', marginTop: 5 }}>{t('hr.subtitle', 'Manage lab employees, roles, and payroll')}</p>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ width: 140, marginRight: 10 }}>
            <select style={filterSelectStyle} value={presenceFilter} onChange={(e) => setPresenceFilter(e.target.value)}>
              <option value="">All Activity</option>
              <option value="online">🟢 Online</option>
              <option value="idle">🟡 Idle</option>
              <option value="offline">🔴 Offline</option>
            </select>
          </div>
          <div style={{ width: 150, marginRight: 10 }}>
            <select style={filterSelectStyle} value={attendanceFilter} onChange={(e) => setAttendanceFilter(e.target.value)}>
              <option value="">All Attendance</option>
              <option value="in">🟢 In</option>
              <option value="out">⚪ Out</option>
              <option value="vacation">🏖️ On Vacation</option>
            </select>
          </div>

          <input
            ref={importFileRef}
            type="file"
            accept=".xlsx, .xls, .csv"
            style={{ display: 'none' }}
            onChange={(e) => window.processHRExcelImport(e.nativeEvent)}
          />
          <button className="btn ghost" style={{ borderColor: '#3b82f6', color: '#3b82f6' }} onClick={() => importFileRef.current?.click()}>
            📤 Import Excel
          </button>
          <button
            className="btn ghost"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            onClick={(e) => window.exportTableToExcel(e.currentTarget, 'hr_employees_directory', '#hr-list-container')}
          >
            📥 Export Excel
          </button>
          <button className="btn" style={{ background: 'var(--teal)', color: '#04121d', fontWeight: 'bold' }} onClick={openAddModal}>
            + Add Employee
          </button>
        </div>
      </div>

      {listContainer &&
        createPortal(
          loadError ? (
            <p style={{ color: 'var(--warn)', padding: 20 }}>Could not connect to database.</p>
          ) : filtered.length === 0 ? (
            <div className="table-container">
              <table style={{ width: '100%' }}>
                <tbody>
                  <tr>
                    <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                      {t('alerts.empty_no_employees_filtered', 'No employees found matching your filters.')}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, marginBottom: 15, minHeight: 38 }}>
                {selectedIds.size > 0 && (
                  <>
                    <button className="btn btn-danger" onClick={handleBulkDelete}>
                      🗑️ Delete Selected
                    </button>
                    <button className="btn" style={{ background: '#3b82f6', color: 'white', border: 'none' }} onClick={handleBulkEmail}>
                      ✉️📱 Notify Selected
                    </button>
                  </>
                )}
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>
                        <input type="checkbox" checked={allChecked} onChange={(e) => toggleSelectAll(e.target.checked)} />
                      </th>
                      <th style={{ width: 50 }}>#</th>
                      <th>Name & Activity</th>
                      <th>System Username</th>
                      <th>Role</th>
                      <th>Phone</th>
                      <th>Salary</th>
                      <th>Status</th>
                      <th>Attendance</th>
                      <th style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((emp, index) => {
                      const presence = emp.presence_status || 'offline';
                      const presenceClass =
                        presence === 'online' ? 'presence-online' : presence === 'idle' ? 'presence-idle' : 'presence-offline';
                      const presenceText = presence === 'online' ? 'Online' : presence === 'idle' ? 'Idle' : 'Offline';
                      const att = emp.attendance_status || { clocked_in: false, since: null, on_vacation: false };

                      return (
                        <tr key={emp.id}>
                          <td>
                            <input type="checkbox" checked={selectedIds.has(emp.id)} onChange={(e) => toggleSelect(emp.id, e.target.checked)} />
                          </td>
                          <td>{index + 1}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <Avatar photoPath={emp.photo_path} name={emp.name} size={36} />
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                  <span className={`presence-dot ${presenceClass}`} title={presenceText}></span>
                                  <strong>{emp.name}</strong>
                                </div>
                                <small style={{ color: 'var(--muted)', fontSize: 11 }}>{emp.email || 'No email'}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {emp.username ? (
                              <span style={{ color: 'var(--teal)', fontWeight: 500 }}>{emp.username}</span>
                            ) : (
                              <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 12 }}>Not assigned</span>
                            )}
                          </td>
                          <td style={{ color: 'var(--muted)' }}>{emp.role}</td>
                          <td>{emp.phone || 'N/A'}</td>
                          <td>
                            <strong>{(parseFloat(String(emp.salary)) || 0).toFixed(2)} EGP</strong>
                          </td>
                          <td>
                            {att.on_vacation ? (
                              <span className="pill info">On Vacation</span>
                            ) : att.clocked_in ? (
                              <span className="pill ok">In since {window.formatCairoDateTime(att.since, false)}</span>
                            ) : (
                              <span className="pill ghost">Out</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              {att.clocked_in ? (
                                <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }} onClick={() => clockOut(emp.id)}>
                                  Clock Out
                                </button>
                              ) : (
                                <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--ok)' }} onClick={() => clockIn(emp.id)}>
                                  Clock In
                                </button>
                              )}
                              <button
                                className="btn ghost"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                onClick={() => setDrillDown({ open: true, empId: emp.id })}
                              >
                                Manage
                              </button>
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => openEditModal(emp)}>
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ),
          listContainer
        )}

      {policyContainer &&
        createPortal(
          <div className="glass-panel" style={{ padding: 15, borderRadius: 8, border: '1px dashed var(--border)', marginBottom: 20 }}>
            <h4 style={{ color: 'var(--warn)', marginBottom: 10 }}>{t('hr.attendance_policy', 'Attendance Policy')}</h4>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 15 }}>
              <div>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('hr.weekly_days_off', 'Weekly Days Off')}
                </label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {WEEKDAY_LABELS.map((label, day) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={attendanceConfig.weekly_days_off.includes(day)}
                        onChange={(e) => toggleWeeklyDayOff(day, e.target.checked)}
                      />{' '}
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('hr.standard_hours_per_day', 'Standard Work Hours / Day')}
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="24"
                  style={{ padding: 8, width: 120 }}
                  value={attendanceConfig.standard_work_hours_per_day}
                  onChange={(e) => setAttendanceConfig((c) => ({ ...c, standard_work_hours_per_day: parseFloat(e.target.value) }))}
                />
              </div>
              <button
                className="btn"
                style={{ background: 'var(--surface-2)', color: 'white', border: '1px solid var(--border)' }}
                onClick={handleSaveAttendanceConfig}
              >
                💾 <span>{t('actions.save', 'Save')}</span>
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 15, flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('hr.holiday_date', 'Date')}
                </label>
                <input
                  type="date"
                  style={{ padding: 8 }}
                  value={newHoliday.date}
                  onChange={(e) => setNewHoliday((h) => ({ ...h, date: e.target.value }))}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>
                  {t('hr.holiday_name', 'Name')}
                </label>
                <input
                  type="text"
                  style={{ padding: 8 }}
                  value={newHoliday.name}
                  onChange={(e) => setNewHoliday((h) => ({ ...h, name: e.target.value }))}
                />
              </div>
              <button className="btn ghost" onClick={handleAddHoliday}>
                {t('hr.add_holiday', '+ Add Holiday')}
              </button>
            </div>
            <div>
              {attendanceConfig.holidays.length === 0 ? (
                <p style={{ color: 'var(--muted)', fontSize: 12 }}>No holidays configured.</p>
              ) : (
                attendanceConfig.holidays.map((h) => (
                  <span
                    key={h.id}
                    className="pill ghost"
                    style={{ margin: 3, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    {h.date}
                    {h.name ? ` — ${h.name}` : ''}
                    <span style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => handleDeleteHoliday(h.id)}>
                      ✕
                    </span>
                  </span>
                ))
              )}
            </div>
          </div>,
          policyContainer
        )}

      {reportContainer &&
        createPortal(
          <div className="glass-panel" style={{ padding: 20, borderRadius: 8, marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 15 }}>
              <h3 style={{ margin: 0 }}>{t('hr.attendance_report', 'Attendance Report')}</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="date"
                  style={{ padding: 6 }}
                  value={reportRange.from}
                  onChange={(e) => setReportRange((r) => ({ ...r, from: e.target.value }))}
                />
                <input
                  type="date"
                  style={{ padding: 6 }}
                  value={reportRange.to}
                  onChange={(e) => setReportRange((r) => ({ ...r, to: e.target.value }))}
                />
                <select style={{ padding: 6 }} defaultValue="month" onChange={(e) => handleReportPresetChange(e.target.value)}>
                  <option value="">Quick range…</option>
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="year">This Year</option>
                </select>
                <button className="btn ghost" style={{ padding: '6px 12px' }} onClick={() => refetchReport(reportRange)}>
                  🔎
                </button>
              </div>
            </div>
            {reportRows.length === 0 ? (
              <div className="table-container">
                <table style={{ width: '100%' }}>
                  <tbody>
                    <tr>
                      <td style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                        {t('alerts.empty_no_employees', 'No employees found.')}
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
                      <th>Name</th>
                      <th>Role</th>
                      <th>Worked</th>
                      <th>Credited</th>
                      <th>Expected</th>
                      <th>%</th>
                      <th style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.map((r) => {
                      const pctColor = r.percentage >= 90 ? 'var(--ok)' : r.percentage >= 70 ? 'var(--warn)' : 'var(--danger)';
                      return (
                        <tr key={r.employee_id}>
                          <td>
                            <strong>{r.name}</strong>
                          </td>
                          <td style={{ color: 'var(--muted)' }}>{r.role || ''}</td>
                          <td>{r.worked_hours}h</td>
                          <td>{r.credited_hours}h</td>
                          <td>{r.expected_hours}h</td>
                          <td>
                            <strong style={{ color: pctColor }}>{r.percentage}%</strong>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setDrillDown({ open: true, empId: r.employee_id })}
                            >
                              Manage
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>,
          reportContainer
        )}

      <div id="employee-modal" className="modal" style={{ display: modal.open ? 'block' : 'none' }}>
        <div className="modal-content glass-panel" style={{ maxWidth: 500 }}>
          <span className="close" onClick={closeModal}>
            &times;
          </span>
          <h2 style={{ marginBottom: 20, color: 'var(--text)' }}>{modal.editingId ? 'Edit Employee' : 'Add New Employee'}</h2>

          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', gap: 15, alignItems: 'center', marginBottom: 20 }}>
              <div style={{ width: 64, height: 64, flexShrink: 0 }}>
                <Avatar photoPath={modal.photoPath} name={modal.name} size={64} />
              </div>
              <div>
                <input type="file" accept="image/*" style={{ display: 'none' }} id="hr-emp-photo-input" onChange={handlePhotoSelected} />
                <button
                  type="button"
                  className="btn ghost"
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => document.getElementById('hr-emp-photo-input')?.click()}
                >
                  📷 Upload Photo
                </button>
                {modal.photoPath && (
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ padding: '6px 12px', fontSize: 12 }}
                    onClick={() => setModal((m) => ({ ...m, photoPath: '' }))}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Full Name *</label>
              <input
                type="text"
                required
                style={{ width: '100%', marginTop: 5 }}
                value={modal.name}
                onChange={(e) => setModal((m) => ({ ...m, name: e.target.value }))}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Role *</label>
              <select
                required
                style={{ width: '100%', marginTop: 5 }}
                value={modal.role}
                onChange={(e) => setModal((m) => ({ ...m, role: e.target.value }))}
              >
                <option value="Pathologist">Pathologist</option>
                <option value="Phlebotomist">Phlebotomist</option>
                <option value="Lab Technician">Lab Technician</option>
                <option value="User">User</option>
                <option value="Admin">Admin</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 25 }}>
              <div>
                <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Phone</label>
                <input type="text" style={{ width: '100%', marginTop: 5 }} value={modal.phone} onChange={(e) => setModal((m) => ({ ...m, phone: e.target.value }))} />
              </div>
              <div>
                <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Salary (EGP)</label>
                <input
                  type="number"
                  step="0.01"
                  style={{ width: '100%', marginTop: 5 }}
                  value={modal.salary}
                  onChange={(e) => setModal((m) => ({ ...m, salary: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 25 }}>
              <div>
                <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Email</label>
                <input
                  type="email"
                  placeholder="name@example.com"
                  style={{ width: '100%', marginTop: 5 }}
                  value={modal.email}
                  onChange={(e) => setModal((m) => ({ ...m, email: e.target.value }))}
                />
              </div>
              <div>
                <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Join Date</label>
                <input
                  type="date"
                  style={{ width: '100%', marginTop: 5 }}
                  value={modal.joinDate}
                  onChange={(e) => setModal((m) => ({ ...m, joinDate: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ marginBottom: 25, padding: 15, background: 'rgba(0,0,0,0.2)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
              <label style={{ color: 'var(--teal)', fontSize: 12, textTransform: 'uppercase', fontWeight: 'bold' }}>
                System Username (For Activity Tracking)
              </label>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, marginBottom: 8 }}>
                Link this employee to a system login to track their live presence.
              </p>
              <input
                type="text"
                placeholder="e.g. dr_okafor (Leave blank if no system access)"
                style={{ width: '100%' }}
                value={modal.username}
                onChange={(e) => setModal((m) => ({ ...m, username: e.target.value }))}
              />
            </div>

            <div style={{ textAlign: 'right' }}>
              <button type="button" className="btn ghost" onClick={closeModal}>
                Cancel
              </button>
              <button type="submit" className="btn" style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }}>
                Save Employee
              </button>
            </div>
          </form>
        </div>
      </div>

      <AttendanceDrillDownModal
        open={drillDown.open}
        empId={drillDown.empId}
        employees={employees}
        onClose={() => setDrillDown({ open: false, empId: null })}
        onMutated={refetch}
      />
    </>
  );
}
