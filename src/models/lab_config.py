from src.models.user import db
from datetime import datetime
import json

class LabConfig(db.Model):
    """Configuration for the laboratory management system."""
    __tablename__ = 'lab_config'

    id = db.Column(db.Integer, primary_key=True)
    lab_name = db.Column(db.String(200), default='Medical Analysis Laboratory')
    lab_director = db.Column(db.String(200), default='Lab Director')
    lab_phone = db.Column(db.String(20))
    lab_address = db.Column(db.String(500))
    logo_path = db.Column(db.Text, default='/shtk.png')
    lab_subtitle = db.Column(db.String(200), default='Pathological Analysis')
    cover_path = db.Column(db.Text, default='/img/default-cover.jpg')
    msg_enabled = db.Column(db.Boolean, default=False)
    msg_method = db.Column(db.String(20), default='whatsapp')
    msg_phone = db.Column(db.String(50), default='')
    theme = db.Column(db.String(10), default='dark')

    # Report branding — lab_director/lab_phone/lab_address above double as the doctor's name /
    # header contact info on the generated report.
    lab_email = db.Column(db.String(200))
    doctor_qualification = db.Column(db.String(200))  # e.g. "M.B.B.S MD"
    doctor_reg_no = db.Column(db.String(100))
    tech_name = db.Column(db.String(200))
    tech_qualification = db.Column(db.String(200))  # e.g. "B.M.L.T"
    tech_institute = db.Column(db.String(200))
    social_facebook = db.Column(db.String(300))
    social_instagram = db.Column(db.String(300))
    social_twitter = db.Column(db.String(300))
    report_footer_note = db.Column(db.Text)
    signature_path = db.Column(db.Text)  # pathologist signature image — same data:/static-path convention as logo_path/cover_path
    signature_title = db.Column(db.String(200))  # caption under the signature, e.g. "Consultant Pathologist"

    # Scheduled access policy. Both existed as raw ALTER TABLE columns (src/main.py) without
    # ever being declared here — save_lab_settings() setting config.force_logout_time was
    # silently non-persistent (an unmapped attribute SQLAlchemy never flushes to the DB); it
    # only ever appeared to work within a single long-lived server process because the ORM's
    # identity map kept returning the same in-memory object. Declaring them here fixes that.
    force_logout_time = db.Column(db.String(10))  # "HH:MM" — non-admins are logged out at this time
    idle_logout_timeout = db.Column(db.Integer, default=0)  # minutes; 0 = disabled
    # New: non-admins can't log back in between force_logout_time and this time (wraps past
    # midnight if resume < logout, e.g. 22:00 -> 06:00). Admins/masters are never affected by
    # either of these — they can always log in and are never force-logged-out.
    login_resume_time = db.Column(db.String(10))

    # Feature toggles
    active_features = db.Column(db.Text, default=json.dumps([
        'dashboard',
        'new-test-order',
        'clients',
        'add-client',
        'pending-samples',
        'completed-tests',
        'client-history',
        'sample-status-manager',
        'reports',
        'financial'
    ]))

    # Attendance policy. weekly_days_off is a JSON list of Python date.weekday() ints
    # (Mon=0..Sun=6), same JSON-in-Text shape as active_features above — always read/written
    # as a whole list, not addressed by individual id, unlike the Holiday table.
    weekly_days_off = db.Column(db.Text, default='[4]')  # [4] = Friday only
    standard_work_hours_per_day = db.Column(db.Float, default=8.0)

    @staticmethod
    def get_config():
        """Get or create the lab configuration."""
        config = LabConfig.query.first()
        if not config:
            config = LabConfig()
            db.session.add(config)
            db.session.commit()
        return config

    def to_dict(self):
        try:
            features = json.loads(self.active_features) if isinstance(self.active_features, str) else self.active_features
        except (json.JSONDecodeError, TypeError):
            features = []

        try:
            days_off = json.loads(self.weekly_days_off) if isinstance(self.weekly_days_off, str) else (self.weekly_days_off or [])
        except (json.JSONDecodeError, TypeError):
            days_off = []

        return {
            'id': self.id,
            'lab_name': self.lab_name,
            'lab_director': self.lab_director,
            'lab_phone': self.lab_phone,
            'lab_address': self.lab_address,
            'logo_path': self.logo_path,
            'lab_subtitle': self.lab_subtitle,
            'active_features': features,
            'cover_path': self.cover_path,
            'msg_enabled': self.msg_enabled,
            'msg_method': self.msg_method,
            'msg_phone': self.msg_phone,
            'theme': self.theme,
            'lab_email': self.lab_email,
            'doctor_qualification': self.doctor_qualification,
            'doctor_reg_no': self.doctor_reg_no,
            'tech_name': self.tech_name,
            'tech_qualification': self.tech_qualification,
            'tech_institute': self.tech_institute,
            'social_facebook': self.social_facebook,
            'social_instagram': self.social_instagram,
            'social_twitter': self.social_twitter,
            'report_footer_note': self.report_footer_note,
            'signature_path': self.signature_path,
            'signature_title': self.signature_title,
            'force_logout_time': self.force_logout_time,
            'idle_logout_timeout': self.idle_logout_timeout,
            'login_resume_time': self.login_resume_time,
            'weekly_days_off': days_off,
            'standard_work_hours_per_day': self.standard_work_hours_per_day,
        }


def is_login_blocked_for_regular_users(config):
    """True if 'now' falls inside the scheduled-lockout window — from force_logout_time up to
    login_resume_time. Wraps past midnight when the resume time is earlier in the clock than
    the logout time (e.g. 22:00 -> 06:00, a "closed overnight" policy); a same-day window
    (e.g. 13:00 -> 15:00) doesn't wrap. Callers are responsible for exempting admins/masters —
    this only answers "is the window active right now", not who it applies to."""
    force_time = config.force_logout_time
    resume_time = config.login_resume_time
    if not force_time or not resume_time:
        return False

    now_str = datetime.now().strftime('%H:%M')
    if force_time <= resume_time:
        return force_time <= now_str < resume_time
    return now_str >= force_time or now_str < resume_time
