import json
from datetime import datetime, time, timedelta

from src.models.attendance import AttendanceSession, AttendancePermission, EmployeeVacation, Holiday
from src.models.lab_config import LabConfig
from src.utils.timezone import now_cairo


def get_weekly_days_off(config):
    """Parses LabConfig.weekly_days_off the same defensive way LabConfig.to_dict() parses
    active_features. Returns a set of date.weekday() ints (Mon=0..Sun=6)."""
    try:
        raw = json.loads(config.weekly_days_off) if isinstance(config.weekly_days_off, str) else (config.weekly_days_off or [])
        return set(int(d) for d in raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return set()


def get_holiday_dates(date_from, date_to):
    rows = Holiday.query.filter(Holiday.date >= date_from, Holiday.date <= date_to).all()
    return {r.date for r in rows}


def get_vacation_dates(employee_id, date_from, date_to):
    """Every date covered by any of this employee's vacations that overlaps the range."""
    rows = EmployeeVacation.query.filter(
        EmployeeVacation.employee_id == employee_id,
        EmployeeVacation.start_date <= date_to,
        EmployeeVacation.end_date >= date_from,
    ).all()
    dates = set()
    for r in rows:
        d = max(r.start_date, date_from)
        end = min(r.end_date, date_to)
        while d <= end:
            dates.add(d)
            d += timedelta(days=1)
    return dates


def compute_expected_hours(employee_id, date_from, date_to, config):
    """Expected working hours over [date_from, date_to] for one employee, skipping weekly
    days-off, company-wide holidays, and that employee's own vacation days. Capped at today
    (Cairo-local) so a period still in progress — e.g. "this month" checked on the 14th —
    isn't penalized for days that haven't happened yet."""
    days_off = get_weekly_days_off(config)
    holidays = get_holiday_dates(date_from, date_to)
    vacation_dates = get_vacation_dates(employee_id, date_from, date_to)
    effective_to = min(date_to, now_cairo().date())

    total = 0.0
    d = date_from
    while d <= effective_to:
        if d.weekday() not in days_off and d not in holidays and d not in vacation_dates:
            total += config.standard_work_hours_per_day or 0.0
        d += timedelta(days=1)
    return total


def compute_worked_hours(employee_id, date_from, date_to):
    """Sums CLOSED sessions only (clock_out IS NOT NULL) overlapping the range, clipped to
    the range boundaries. An open (never clocked-out) session contributes nothing — it must
    not be able to inflate the percentage no matter how long it's been left open."""
    range_start = datetime.combine(date_from, time.min)
    range_end = datetime.combine(date_to, time.max)
    sessions = AttendanceSession.query.filter(
        AttendanceSession.employee_id == employee_id,
        AttendanceSession.clock_out.isnot(None),
        AttendanceSession.clock_in <= range_end,
        AttendanceSession.clock_out >= range_start,
    ).all()

    total_seconds = 0.0
    for s in sessions:
        clipped_start = max(s.clock_in, range_start)
        clipped_end = min(s.clock_out, range_end)
        total_seconds += max((clipped_end - clipped_start).total_seconds(), 0)
    return total_seconds / 3600.0


def compute_credited_permission_hours(employee_id, date_from, date_to):
    """Sums every AttendancePermission in range — no status filter, since admin/HR
    recording one directly IS the approval (there's no separate request/review step)."""
    rows = AttendancePermission.query.filter(
        AttendancePermission.employee_id == employee_id,
        AttendancePermission.permission_date >= date_from,
        AttendancePermission.permission_date <= date_to,
    ).all()
    return sum(r.credited_hours for r in rows)


def compute_attendance_percentage(employee_id, date_from, date_to):
    """Single source of truth for the attendance percentage, used by both the per-employee
    and all-employees report endpoints. percentage = (worked + excused hours) / expected
    hours for the period, capped at 100 to absorb rounding on a long single day."""
    config = LabConfig.get_config()
    expected = compute_expected_hours(employee_id, date_from, date_to, config)
    worked = compute_worked_hours(employee_id, date_from, date_to)
    credited = compute_credited_permission_hours(employee_id, date_from, date_to)
    percentage = 0.0 if expected == 0 else min(100.0, round((worked + credited) / expected * 100, 1))

    return {
        'employee_id': employee_id,
        'date_from': date_from.isoformat(),
        'date_to': date_to.isoformat(),
        'expected_hours': round(expected, 2),
        'worked_hours': round(worked, 2),
        'credited_hours': round(credited, 2),
        'percentage': percentage,
    }
