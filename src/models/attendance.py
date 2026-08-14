from src.models.user import db


class AttendanceSession(db.Model):
    """One row = one clock-in/clock-out session (clock_out NULL while still open) — not one
    row per day, so an employee can be clocked in/out multiple times in the same day (a
    split shift). Keyed by employee_id, not username — not every employee has a system
    login (see Employee.username), and attendance here is recorded by admin/HR on the
    employee's behalf, not self-service."""
    __tablename__ = 'attendance_sessions'

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employees.id', ondelete='CASCADE', name='fk_attendance_sessions_employee_id'), nullable=False, index=True)
    clock_in = db.Column(db.DateTime, nullable=False)
    clock_out = db.Column(db.DateTime, nullable=True)
    created_by = db.Column(db.String(80), nullable=False)  # admin/HR username who recorded it
    edited_by = db.Column(db.String(80), nullable=True)
    note = db.Column(db.Text, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'employee_id': self.employee_id,
            'clock_in': self.clock_in.strftime('%Y-%m-%d %H:%M:%S') if self.clock_in else None,
            'clock_out': self.clock_out.strftime('%Y-%m-%d %H:%M:%S') if self.clock_out else None,
            'created_by': self.created_by,
            'edited_by': self.edited_by,
            'note': self.note,
            'is_open': self.clock_out is None,
        }


class AttendancePermission(db.Model):
    """Admin-recorded excused hours for one employee on one date (e.g. arrived late, left
    early). Entered directly as a fact by admin/HR — not a request someone else approves,
    since only admin/HR can create one in the first place."""
    __tablename__ = 'attendance_permissions'

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employees.id', ondelete='CASCADE', name='fk_attendance_permissions_employee_id'), nullable=False, index=True)
    permission_date = db.Column(db.Date, nullable=False)
    start_time = db.Column(db.String(5), nullable=False)  # "HH:MM"
    end_time = db.Column(db.String(5), nullable=False)    # "HH:MM"
    credited_hours = db.Column(db.Float, nullable=False)
    reason = db.Column(db.Text, nullable=True)
    created_by = db.Column(db.String(80), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'employee_id': self.employee_id,
            'permission_date': self.permission_date.isoformat() if self.permission_date else None,
            'start_time': self.start_time,
            'end_time': self.end_time,
            'credited_hours': self.credited_hours,
            'reason': self.reason,
            'created_by': self.created_by,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M') if self.created_at else None,
        }


class EmployeeVacation(db.Model):
    """A multi-day leave assigned to one employee by admin/HR — the per-employee analog of
    Holiday (which applies to everyone). Every date in [start_date, end_date] is excluded
    from that employee's expected working hours."""
    __tablename__ = 'employee_vacations'

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employees.id', ondelete='CASCADE', name='fk_employee_vacations_employee_id'), nullable=False, index=True)
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)
    reason = db.Column(db.String(300), nullable=True)
    created_by = db.Column(db.String(80), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'employee_id': self.employee_id,
            'start_date': self.start_date.isoformat() if self.start_date else None,
            'end_date': self.end_date.isoformat() if self.end_date else None,
            'reason': self.reason,
            'created_by': self.created_by,
        }


class Holiday(db.Model):
    """A one-off calendar holiday (a specific date, e.g. a national holiday) excluding that
    date from every employee's expected working hours. Recurring weekly days off are NOT
    here — see LabConfig.weekly_days_off. Per-employee leave is EmployeeVacation, not this."""
    __tablename__ = 'holidays'

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False, unique=True)
    name = db.Column(db.String(200), nullable=True)
    created_by = db.Column(db.String(80), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'date': self.date.isoformat() if self.date else None,
            'name': self.name,
            'created_by': self.created_by,
        }
