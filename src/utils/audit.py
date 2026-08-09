import traceback

from flask import request, session

from src.models.audit import ActivityLog
from src.models.user import db


def log_activity(event_type, resource=None, resource_id=None, description=None,
                  status='success', username=None, role=None, workspace=None):
    """Writes one ActivityLog row. Never raises — a logging failure must not break the
    request it's describing. `username`/`role`/`workspace` default to the current session,
    but callers pass them explicitly for events where the session isn't populated yet (a
    failed login has no session identity — the attempted username is passed instead)."""
    try:
        entry = ActivityLog(
            username=username or session.get('username'),
            role=role or session.get('role'),
            workspace=workspace or session.get('workspace'),
            event_type=event_type,
            resource=resource,
            resource_id=str(resource_id) if resource_id is not None else None,
            description=description,
            status=status,
            method=request.method if request else None,
            path=request.path if request else None,
            ip_address=(request.headers.get('X-Forwarded-For', request.remote_addr) if request else None),
            user_agent=(request.headers.get('User-Agent', '')[:255] if request else None),
        )
        db.session.add(entry)
        db.session.commit()
    except Exception:
        db.session.rollback()
        print("Failed to write activity log:\n" + traceback.format_exc())


# Requests to these paths are excluded from the generic mutating-request logger in
# main.py's after_request hook — either because they already have their own explicit,
# richer log_activity() call (login/logout), or because they're frequent-heartbeat/
# self-referential noise that wouldn't add anything meaningful to "who did what" (presence
# pings, and the view-tracking endpoint itself).
GENERIC_LOG_EXCLUDED_PATHS = {
    '/api/auth/login', '/api/auth/logout', '/api/auth/presence', '/api/activity/view',
}


def derive_resource(path):
    """Best-effort resource name from a URL path — '/api/warehouse/bills/3' -> 'warehouse'.
    Not authoritative per-route semantics, just enough for a readable log without having to
    manually instrument every route."""
    parts = [p for p in path.split('/') if p]
    if len(parts) >= 2 and parts[0] == 'api':
        return parts[1]
    return path


def derive_resource_id(path):
    """Last numeric path segment, if any — '/api/warehouse/bills/3/status' -> '3'."""
    numeric_parts = [p for p in path.split('/') if p.isdigit()]
    return numeric_parts[-1] if numeric_parts else None


EVENT_TYPE_BY_METHOD = {'POST': 'create', 'PUT': 'update', 'PATCH': 'update', 'DELETE': 'delete'}
