from datetime import datetime
from src.models.user import db


# One row per tracked event: auth (login/logout/failed login), a mutating API call
# (create/update/delete, captured generically via an after_request hook so new routes are
# covered automatically instead of needing per-route instrumentation), or a tab/page view
# (captured explicitly via POST /api/activity/view, called once per tab switch — logging
# every background polling GET would be noise, not a meaningful "what did the user look at").
class ActivityLog(db.Model):
    __tablename__ = 'activity_log'

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    username = db.Column(db.String(100), index=True)
    role = db.Column(db.String(20))
    workspace = db.Column(db.String(20))
    event_type = db.Column(db.String(20), index=True)  # login, login_failed, logout, view, create, update, delete
    resource = db.Column(db.String(50))
    resource_id = db.Column(db.String(50), nullable=True)
    description = db.Column(db.String(255))
    status = db.Column(db.String(20), default='success')  # success, failed
    method = db.Column(db.String(10), nullable=True)
    path = db.Column(db.String(255), nullable=True)
    ip_address = db.Column(db.String(64), nullable=True)
    user_agent = db.Column(db.String(255), nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.strftime('%Y-%m-%d %H:%M:%S') if self.timestamp else None,
            'username': self.username,
            'role': self.role,
            'workspace': self.workspace,
            'event_type': self.event_type,
            'resource': self.resource,
            'resource_id': self.resource_id,
            'description': self.description,
            'status': self.status,
            'method': self.method,
            'path': self.path,
            'ip_address': self.ip_address,
        }
