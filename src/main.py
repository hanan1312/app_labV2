import os
import sys
from functools import wraps
from sqlalchemy import create_engine, text, event, or_
from sqlalchemy.engine import Engine
from datetime import datetime, date
import time
import secrets
from dotenv import load_dotenv

# Loads .env into os.environ before anything reads config from it (SMTP_* for HR email —
# see src/utils/email_sender.py). A no-op if there's no .env file; never overrides a
# variable that's already set in the real environment (e.g. by PM2's ecosystem config).
load_dotenv()


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    """SQLite ignores declared FKs unless enforcement is turned on per-connection."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, send_from_directory, redirect, session, request, jsonify,render_template
from flask_cors import CORS

from config import DevelopmentConfig, ProductionConfig, DB_DIR 
from src.models.user import db, User, LabTest, TransactionList, PatientVisit, WarehouseItem, WarehouseBill,Employee, WarehouseWorkOrder, WarehouseBatch, WarehouseWorkOrderScan
from src.models.client import Client
from src.models.test_result import TestResult
from src.models.test_parameter import TestParameterTemplate
from src.models.lab_config import LabConfig, is_login_blocked_for_regular_users
from src.models.audit import ActivityLog
# Junction tables (docs/schema_migration_plan.md) — imported so create_all() sees them;
# sync_*/add_* helpers keep them live from the write sites below (Phase 2)
from src.models.junctions import (
    UserPermission, ClientAllergy, VisitTest, VisitReport, TransactionLineItem,
    sync_user_permissions, sync_visit_tests, add_visit_reports, sync_transaction_line_items,
    get_visit_test_names, get_visit_report_url, get_transaction_test_names,
    get_completed_test_names,
    DEFAULT_PERMISSIONS,
)
from src.routes.user import user_bp, admin_required
from src.routes.patient import patient_bp
from src.routes.clinic import clinic_bp
from src.routes.client import client_bp
from src.routes.test_result import test_result_bp
from src.routes.lab import lab_bp
from src.routes.financial import financial_bp
from src.routes.reports import reports_bp, build_report_context
from src.utils.error_handlers import register_error_handlers
from src.utils.audit import (
    log_activity, derive_resource, derive_resource_id, EVENT_TYPE_BY_METHOD,
    GENERIC_LOG_EXCLUDED_PATHS,
)
from src.utils.email_sender import is_email_configured, send_email


app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), 'static'))

# --- CONFIGURATION UPGRADE ---
env = os.environ.get('FLASK_ENV', 'development')
if env == 'production':
    app.config.from_object(ProductionConfig)
else:
    app.config.from_object(DevelopmentConfig)

# SECRET_KEY comes from Config (env var SECRET_KEY, falling back to a dev-only default) —
# it used to be hardcoded here unconditionally, silently discarding any env-configured key.
# -----------------------------

CORS(app, supports_credentials=True)
register_error_handlers(app)

app.register_blueprint(user_bp, url_prefix='/api/auth')
app.register_blueprint(patient_bp, url_prefix='/api')
app.register_blueprint(clinic_bp, url_prefix='/api')
app.register_blueprint(client_bp, url_prefix='/api')
app.register_blueprint(test_result_bp, url_prefix='/api')
app.register_blueprint(lab_bp, url_prefix='/api')
app.register_blueprint(financial_bp, url_prefix='/api/financial')
app.register_blueprint(reports_bp, url_prefix='/api')

db.init_app(app)

# --- DYNAMIC DATABASE ENGINES ---
with app.app_context():
    # Fetch URIs
    clinic_uri = app.config.get('SQLALCHEMY_DATABASE_URI')
    lab_db_path = os.path.join(DB_DIR, 'app.db').replace('\\', '/')
    lab_uri = f"sqlite:///{lab_db_path}"
    
    # Store engines globally so our interceptor can access them
    app.clinic_engine = create_engine(clinic_uri)
    app.lab_engine = create_engine(lab_uri)
    for engine in [app.lab_engine, app.clinic_engine]:
        # One statement per try/except — bundling these in a single try meant the first
        # already-applied ALTER (almost always "employee.username" on any DB that had already
        # been migrated once) raised immediately and skipped every statement after it. In
        # practice this meant force_logout_time/idle_logout_timeout were NEVER added past the
        # very first run on a given database, silently: LabConfig has no db.Column for them
        # either (fixed separately in src/models/lab_config.py), so nothing ever surfaced the
        # missing columns until something tried to query them directly.
        db.session.bind = engine
        for statement in [
            "ALTER TABLE employees ADD COLUMN username VARCHAR(80)",
            "ALTER TABLE lab_config ADD COLUMN force_logout_time VARCHAR(10)",
            "ALTER TABLE lab_config ADD COLUMN idle_logout_timeout INTEGER DEFAULT 0",
        ]:
            try:
                db.session.execute(text(statement))
                db.session.commit()
            except Exception:
                db.session.rollback()

        # Structured results-entry feature — one statement per try/except (unlike the block
        # above, where the first failure skips every later ALTER on an already-migrated db).
        db.session.bind = engine
        for statement in [
            "ALTER TABLE test_results ADD COLUMN visit_id INTEGER REFERENCES patient_visits(id)",
            "ALTER TABLE test_results ADD COLUMN lab_test_id INTEGER REFERENCES lab_tests(id)",
            "ALTER TABLE patient_visits ADD COLUMN referred_by VARCHAR(200) DEFAULT 'Self'",
            "ALTER TABLE lab_config ADD COLUMN lab_email VARCHAR(200)",
            "ALTER TABLE lab_config ADD COLUMN doctor_qualification VARCHAR(200)",
            "ALTER TABLE lab_config ADD COLUMN doctor_reg_no VARCHAR(100)",
            "ALTER TABLE lab_config ADD COLUMN tech_name VARCHAR(200)",
            "ALTER TABLE lab_config ADD COLUMN tech_qualification VARCHAR(200)",
            "ALTER TABLE lab_config ADD COLUMN tech_institute VARCHAR(200)",
            "ALTER TABLE lab_config ADD COLUMN social_facebook VARCHAR(300)",
            "ALTER TABLE lab_config ADD COLUMN social_instagram VARCHAR(300)",
            "ALTER TABLE lab_config ADD COLUMN social_twitter VARCHAR(300)",
            "ALTER TABLE lab_config ADD COLUMN report_footer_note TEXT",
            "ALTER TABLE lab_config ADD COLUMN login_resume_time VARCHAR(10)",
        ]:
            try:
                db.session.execute(text(statement))
                db.session.commit()
            except Exception:
                db.session.rollback()

        # New table for the results-entry feature — restricted to just this table so it can
        # never touch any existing one.
        db.Model.metadata.create_all(bind=engine, tables=[TestParameterTemplate.__table__])
        # New table for the Warehouse "Work Order" (stock-issuing) feature — same
        # restricted-to-just-this-table approach.
        db.Model.metadata.create_all(bind=engine, tables=[WarehouseWorkOrder.__table__])
        # New table for the activity/audit log.
        db.Model.metadata.create_all(bind=engine, tables=[ActivityLog.__table__])
        # New tables for warehouse batch/expiry tracking and per-scan fulfillment audit.
        db.Model.metadata.create_all(bind=engine, tables=[WarehouseBatch.__table__])
        db.Model.metadata.create_all(bind=engine, tables=[WarehouseWorkOrderScan.__table__])

        # Guarded, one-time backfill for the new WarehouseWorkOrder lifecycle columns — NOT
        # folded into the blind per-statement ALTER loops above. Those loops backfill every
        # existing row with the DEFAULT (here, status='requested'), but every work-order row
        # that already existed before this feature was created under the OLD immediate-
        # deduction model — its stock is already gone. Coming back as 'requested' would let an
        # admin "approve" a year-old row and a tech scan against it, double-deducting stock
        # that was already removed at creation time. So: add the columns, then explicitly mark
        # every pre-existing row 'completed' in the same guarded block, before any genuinely
        # new 'requested' row can exist to be confused with one of these.
        db.session.bind = engine
        needs_backfill = False
        try:
            db.session.execute(text("SELECT status FROM warehouse_work_orders LIMIT 1"))
        except Exception:
            db.session.rollback()
            needs_backfill = True

        if needs_backfill:
            try:
                db.session.execute(text("ALTER TABLE warehouse_work_orders ADD COLUMN status VARCHAR(20) DEFAULT 'requested'"))
                db.session.execute(text("ALTER TABLE warehouse_work_orders ADD COLUMN quantity_fulfilled INTEGER DEFAULT 0"))
                db.session.execute(text("ALTER TABLE warehouse_work_orders ADD COLUMN approved_by VARCHAR(100)"))
                db.session.execute(text("ALTER TABLE warehouse_work_orders ADD COLUMN approved_at DATETIME"))
                db.session.execute(text(
                    "UPDATE warehouse_work_orders SET status='completed', quantity_fulfilled=quantity"
                ))
                db.session.commit()
            except Exception:
                db.session.rollback()

# Requests to these /api/* paths are allowed without a logged-in session — login itself,
# logout (a no-op if there's no session to clear anyway), and the feature-flag endpoint the
# frontend needs before it knows whether anyone is logged in.
PUBLIC_API_PATHS = {'/api/auth/login', '/api/auth/logout', '/api/features'}


def require_permission(permission_name):
    """Gate a route by the same permission strings setupUIForRole() already uses client-side
    to show/hide sidebar tabs (data-tab="hr-management" <-> permission "hr-management", etc.)
    — admins/masters always pass, matching that same client-side rule. Use this instead of
    admin_required for feature areas the permission system already models as delegable to a
    non-admin (HR, lab settings); reserve admin_required itself for actions that are
    inherently admin-level regardless of any permission string (creating/deleting accounts,
    granting permissions)."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            role = (session.get('role') or '').lower()
            user_id = session.get('user_id')
            if role == 'admin' or str(user_id).startswith('master_'):
                return f(*args, **kwargs)
            has_permission = UserPermission.query.filter_by(
                user_id=user_id, permission=permission_name).first() is not None
            if not has_permission:
                return jsonify({'error': 'Permission denied'}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator

# --- REQUEST INTERCEPTOR ---
@app.before_request
def before_request_interceptor():
    """Intercept API requests to enforce auth, offline lockouts, and bind the DB."""

    # 0. BASELINE AUTHENTICATION. Previously almost no route here (or in any blueprint) had
    # a server-side check at all — permissions were only used to hide/show UI client-side,
    # so any of the ~39 routes in this file plus every blueprint route could be called
    # directly, by anyone, without ever logging in. This closes that gap in one place instead
    # of needing a decorator added to every existing and future route.
    if request.path.startswith('/api/') and request.path not in PUBLIC_API_PATHS:
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required. Please log in.'}), 401

    # 1. STRICT OFFLINE LOGOUT ENFORCEMENT — regular users only; admins/masters are exempt
    # (same exemption as the scheduled-lockout check below), since attendance-style presence
    # policies were never meant to apply to them. Ignore the login/logout routes to prevent
    # infinite loops.
    #
    # Enforcement is time-based ONLY (no heartbeat in the last PRESENCE_TIMEOUT_SECONDS) —
    # it deliberately does NOT treat an explicit status=='offline' report as an instant kill
    # anymore. That used to be possible: the beforeunload handler reports 'offline' via
    # navigator.sendBeacon, which the browser can deliver later than expected (e.g. queued
    # while the network is down, delivered only once it's back) — carrying whatever session
    # cookie is current *at delivery time*. If a user's connection drops, then comes back and
    # they log back in before that queued beacon finally lands, it would arrive tagged with
    # the brand-new session and immediately overwrite its fresh 'online' status back to
    # 'offline', killing the new session on its very next request. A stale report can't do
    # that under a purely time-based check, since a session that's actually being used keeps
    # its own last_seen fresh regardless of what any old queued signal claims.
    if request.path.startswith('/api/') and request.path not in ['/api/auth/login', '/api/auth/logout']:
        role = (session.get('role') or '').lower()
        user_id = str(session.get('user_id', ''))
        username = session.get('username')

        if (username and role != 'admin' and not user_id.startswith('master_')
                and username in PRESENCE_STORE):
            user_data = PRESENCE_STORE[username]
            time_offline = time.time() - user_data['last_seen']

            if time_offline > PRESENCE_TIMEOUT_SECONDS:
                # Destroy their backend session completely
                session.clear()
                return jsonify({'error': 'Session ended due to offline status'}), 401

    # 2. BIND DATABASE (Your existing logic)
    if (request.path.startswith('/api/') or request.path.startswith('/patient-history/')
            or request.path.startswith('/report/') or request.path.startswith('/results-entry/')) \
            and request.path != '/api/auth/login':
        workspace = request.headers.get('X-App-Mode') or session.get('workspace', 'clinic')

        if workspace == 'lab':
            db.session.bind = app.lab_engine
        else:
            db.session.bind = app.clinic_engine

    # 3. SCHEDULED ACCESS LOCKOUT — catches sessions that were already logged in before the
    # configured window started (the client-side timer in script_lab.js handles the common
    # case of an open tab, but this covers a backgrounded/idle tab that never gets the memo,
    # and is authoritative either way). Mirrors the matching check in login() for new logins;
    # admins/masters are exempt from both.
    if request.path.startswith('/api/') and request.path not in ['/api/auth/login', '/api/auth/logout']:
        role = (session.get('role') or '').lower()
        user_id = str(session.get('user_id', ''))
        if 'user_id' in session and role != 'admin' and not user_id.startswith('master_'):
            if is_login_blocked_for_regular_users(LabConfig.get_config()):
                session.clear()
                return jsonify({'error': 'System access is currently restricted for non-admin accounts.'}), 401


@app.after_request
def after_request_activity_logger(response):
    """Generic audit-trail capture for every mutating API call (POST/PUT/PATCH/DELETE),
    covering every blueprint and every route in this file automatically — instead of
    instrumenting each route by hand (high effort, easy to miss one as the app grows).
    Login/logout/presence/the view-tracking endpoint itself are excluded: the first two get
    their own richer explicit log_activity() calls, the latter two are heartbeat/
    self-referential noise. GET requests aren't logged here — meaningful "views" are
    captured separately via POST /api/activity/view, fired once per tab switch instead of
    on every background polling GET."""
    try:
        if (request.path.startswith('/api/')
                and request.method in EVENT_TYPE_BY_METHOD
                and request.path not in GENERIC_LOG_EXCLUDED_PATHS):
            log_activity(
                EVENT_TYPE_BY_METHOD[request.method],
                resource=derive_resource(request.path),
                resource_id=derive_resource_id(request.path),
                description=f"{request.method} {request.path} → {response.status_code}",
                status='success' if response.status_code < 400 else 'failed',
            )
    except Exception:
        pass
    return response

PRESENCE_STORE = {}
PRESENCE_TIMEOUT_SECONDS = 16 * 60
@app.route('/api/auth/presence', methods=['POST'])
def update_presence():
    data = request.json or {}
    status = data.get('status', 'online')
    
    # Safely get the username from the JS payload, or fallback to the session
    username = data.get('username') or session.get('username')
    
    # If we still don't know who this is, reject it
    if not username:
        return jsonify({'error': 'Not logged in or missing username'}), 401
    
    # Store their live status
    PRESENCE_STORE[username] = {
        'status': status,
        'last_seen': time.time()
    }

    return jsonify({'success': True})

@app.route('/api/activity/online', methods=['GET'])
@admin_required
def get_online_users():
    """Reuses PRESENCE_STORE (already fed by the presence-ping above) instead of a separate
    tracking mechanism — "who's online" is just "whose last ping was recent and not
    explicitly offline", for every user, not just the per-employee view HR already has."""
    now = time.time()
    online = []
    for username, data in PRESENCE_STORE.items():
        seconds_ago = now - data['last_seen']
        if seconds_ago <= PRESENCE_TIMEOUT_SECONDS and data.get('status') != 'offline':
            online.append({
                'username': username,
                'status': data['status'],
                'last_seen_seconds_ago': int(seconds_ago),
            })
    online.sort(key=lambda u: u['last_seen_seconds_ago'])
    return jsonify(online)

@app.route('/api/activity/view', methods=['POST'])
def log_view():
    """Fired once per tab switch (see showTab() in script_lab.js) rather than on every
    background polling GET — that would be noise, not a meaningful "what did they look at"."""
    data = request.json or {}
    tab = data.get('tab', 'unknown')
    log_activity('view', resource='tab', resource_id=tab, description=f"Viewed {tab}")
    return jsonify({'success': True})

@app.route('/api/activity', methods=['GET'])
@admin_required
def get_activity_log():
    query = ActivityLog.query

    username = request.args.get('username')
    if username:
        query = query.filter(ActivityLog.username == username)

    event_type = request.args.get('event_type')
    if event_type:
        query = query.filter(ActivityLog.event_type == event_type)

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    if date_from:
        query = query.filter(ActivityLog.timestamp >= date_from)
    if date_to:
        query = query.filter(ActivityLog.timestamp <= date_to + ' 23:59:59')

    search = request.args.get('search')
    if search:
        like = f'%{search}%'
        query = query.filter(or_(
            ActivityLog.description.ilike(like),
            ActivityLog.username.ilike(like),
            ActivityLog.resource.ilike(like),
        ))

    query = query.order_by(ActivityLog.id.desc())

    page = request.args.get('page', type=int)
    per_page = request.args.get('per_page', default=100, type=int)
    if page:
        total = query.count()
        items = query.offset((page - 1) * per_page).limit(per_page).all()
        return jsonify({
            'items': [i.to_dict() for i in items],
            'page': page,
            'per_page': per_page,
            'total_pages': max(1, -(-total // per_page)),
            'total': total,
        })

    return jsonify([i.to_dict() for i in query.all()])

# Add to main.py
@app.route('/api/lab/settings', methods=['GET'])
def get_lab_settings():
    config = LabConfig.get_config()
    return jsonify(config.to_dict())

@app.route('/api/lab/settings', methods=['POST'])
@require_permission('settings')
def save_lab_settings():
    data = request.json
    config = LabConfig.get_config()
    config.lab_name = data.get('lab_name', config.lab_name)
    config.lab_subtitle = data.get('lab_subtitle', config.lab_subtitle)
    config.logo_path = data.get('logo_path', config.logo_path)
    config.cover_path = data.get('cover_path', config.cover_path)
    # --- REPORT BRANDING (doctor/tech credentials, contact, social) ---
    for field in ('lab_director', 'lab_phone', 'lab_address', 'lab_email',
                  'doctor_qualification', 'doctor_reg_no', 'tech_name',
                  'tech_qualification', 'tech_institute', 'social_facebook',
                  'social_instagram', 'social_twitter', 'report_footer_note'):
        if field in data:
            setattr(config, field, data[field])
    if 'msg_enabled' in data:
        config.msg_enabled = bool(data['msg_enabled'])
    if 'msg_method' in data:
        config.msg_method = data['msg_method']
    if 'msg_phone' in data:
        config.msg_phone = data['msg_phone']
    # --- NEW SECURITY POLICIES ---
    if 'force_logout_time' in data:
        config.force_logout_time = data['force_logout_time']
    if 'login_resume_time' in data:
        config.login_resume_time = data['login_resume_time']
    if 'idle_logout_timeout' in data:
        config.idle_logout_timeout = int(data['idle_logout_timeout'])
    if 'theme' in data:
        config.theme = data['theme']
    db.session.commit()
    return jsonify({'success': True})

# Split out from save_lab_settings() above: that route is admin-only (lab branding, security
# policy, contact info), but light/dark theme is a personal preference every logged-in user
# toggles from the topbar, not an admin setting — it shouldn't require admin privileges.
@app.route('/api/lab/settings/theme', methods=['POST'])
def save_theme_preference():
    data = request.json or {}
    theme = data.get('theme')
    if theme not in ('light', 'dark'):
        return jsonify({'error': 'Invalid theme'}), 400
    config = LabConfig.get_config()
    config.theme = theme
    db.session.commit()
    return jsonify({'success': True})

# --- REQUEST INTERCEPTOR ---
@app.before_request
def bind_database():
    """Intercept API requests and bind the correct database engine."""
    # UPDATE THIS LINE to include patient-history
    if (request.path.startswith('/api/') or request.path.startswith('/patient-history/')
            or request.path.startswith('/report/') or request.path.startswith('/results-entry/')) \
            and request.path != '/api/auth/login':
        workspace = request.headers.get('X-App-Mode') or session.get('workspace', 'clinic')
        
        if workspace == 'lab':
            db.session.bind = app.lab_engine
        else:
            db.session.bind = app.clinic_engine

# --- FEATURE FLAGS ---
def is_workspace_switcher_enabled():
    """
    Check if the workspace switcher should be enabled.
    It's enabled if the user is a master admin from admins.json.
    """
    user_id = str(session.get('user_id', ''))
    return user_id.startswith('master_')

@app.route('/api/features')
def get_features():
    """Endpoint to provide feature flags to the frontend."""
    return {"workspace_switcher": is_workspace_switcher_enabled()}

# --- ROUTES ---

@app.route('/login')
def login_page():
    # Smart session check to prevent infinite loops and handle master accounts!
    if 'user_id' in session:
        user_id = str(session['user_id'])
        
        # If it's a master account, they are valid, send them to dashboard
        if user_id.startswith('master_'):
            return redirect('/')
            
        # If it's a regular user, bind the correct database before checking
        workspace = session.get('workspace', 'clinic')
        if workspace == 'lab':
            db.session.bind = app.lab_engine
        else:
            db.session.bind = app.clinic_engine 
            
        # Verify the database user actually exists
        if User.query.get(session['user_id']):
            return redirect('/') 
        else:
            session.pop('user_id', None) 

    return send_from_directory(app.static_folder, 'login.html')


@app.route('/api/users', methods=['GET'])
@admin_required
def get_users():
    users = User.query.all()
    # Reads from user_permissions now (Phase 2 cutover) instead of the users.permissions column
    return jsonify([{
        'id': u.id,
        'username': u.username,
        'role': u.role,
        'permissions': ','.join(p.permission for p in UserPermission.query.filter_by(user_id=u.id).all())
    } for u in users])

# 2. Add User (Updated to fix hashing and email constraints)
@app.route('/api/users', methods=['POST'])
@admin_required
def add_user():
    data = request.json
    
    # Check if user already exists to prevent crashes
    if User.query.filter_by(username=data['username']).first():
        return jsonify({'error': 'Username already exists'}), 400
        
    # Create the user and auto-generate a dummy email to satisfy the database
    new_user = User(
        username=data['username'],
        email=f"{data['username'].lower().replace(' ', '')}@medicio-lab.com", 
        role=data['role']
    )
    
    # IMPORTANT: Hash the password using the function from your user.py model!
    new_user.set_password(data['password'])

    db.session.add(new_user)
    db.session.commit()

    sync_user_permissions(new_user, DEFAULT_PERMISSIONS)
    db.session.commit()

    return jsonify({'success': True, 'message': 'User added successfully'})

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_user(user_id):
    user = User.query.get(user_id)
    if user and user.role != 'lab_master': # Protect the master account!
        db.session.delete(user)
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'error': 'Cannot delete this user'}), 400


@app.route('/api/auth/users/<int:user_id>/permissions', methods=['PUT'])
@admin_required
def update_permissions(user_id):
    user = User.query.get(user_id)
    if not user: return jsonify({'error': 'User not found'}), 404
    
    # Expecting a comma-separated string like "dashboard,patients,reports"
    sync_user_permissions(user, request.json.get('permissions', ''))
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/check-admin', methods=['GET'])
def check_admin():
    # Assuming you have a way to identify the current user (e.g., session)
    current_user = session.get('username') 
    
    if os.path.exists('admins.json'):
        with open('admins.json', 'r') as f:
            admins = json.load(f)
            # Check if user is in the list
            is_admin = current_user in admins
            return jsonify({'is_admin': is_admin})
            
    return jsonify({'is_admin': False})

# Route 1: Get all tests (Used by the frontend to load the table)
@app.route('/api/tests', methods=['GET'])
def get_all_tests():
    tests = LabTest.query.all()
    # Convert database objects into a JSON list
    tests_data = [{'id': t.id, 'name': t.name, 'price': t.price, 'sample_type': getattr(t, 'sample_type', 'Unspecified')} for t in tests]
    return jsonify(tests_data)

# Route 2: Add or Edit a test
@app.route('/api/tests', methods=['POST'])
def save_test():
    data = request.json
    test_id = data.get('id')
    
    if test_id:
        # Edit existing test
        test = LabTest.query.get(test_id)
        if not test:
            return jsonify({'error': 'Test not found'}), 404
        test.name = data['name']
        test.price = float(data['price'])
        if 'sample_type' in data:
            test.sample_type = data['sample_type']
    else:
        # Create new test
        test = LabTest(name=data['name'], price=float(data['price']))
        if 'sample_type' in data:
            test.sample_type = data['sample_type']
        db.session.add(test)
        
    db.session.commit()
    return jsonify({'success': True, 'message': 'Test saved successfully!'})


# Route 3: Delete a test
@app.route('/api/tests/<int:test_id>', methods=['DELETE'])
def delete_test(test_id):
    try:
        # Find the exact test in your LabTest database model
        test = LabTest.query.get(test_id)
        
        # If the test doesn't exist, return an error
        if not test:
            return jsonify({'error': 'Test not found'}), 404
            
        # Delete it and save the changes to the database
        db.session.delete(test)
        db.session.commit()
        
        return jsonify({'success': True, 'message': f'Test {test_id} deleted successfully!'}), 200

    except Exception as e:
        # If something goes wrong with the database, roll back to prevent crashes
        db.session.rollback()
        print(f"Error deleting test: {e}")
        return jsonify({'error': 'Failed to delete test from database'}), 500

import json

@app.route('/api/transactions', methods=['POST'])
def save_transaction():
    data = request.json
    
    # 1. Save to TransactionList (Billing info)
    new_transaction = TransactionList(
        transaction_id=data['transaction_id'],
        patient_id=data['patient_id'],
        patient_name=data['patient_name'],
        patient_phone=data['patient_phone'],
        date=data['date'],
        total_price=data['total_price'],
        discount_percentage=data['discount_percentage'],
        payment_method=data['payment_method'],
        final_payment=float(data['final_payment'])
    )
    db.session.add(new_transaction)

    # 2. Save to PatientVisit (Historical row for the Dashboard)
    new_visit = PatientVisit(
        patient_id=data['patient_id'],
        patient_name=data['patient_name'],
        visit_id=data['transaction_id'],
        date=data['date'],
        status='pending' # Explicitly set this to pending
    )
    db.session.add(new_visit)

    # 3. REMOVED: Do not overwrite the patient's test_type or sample_status here anymore!

    db.session.commit()

    # data['prices'] is the real per-test price chosen at booking time, so this is a true
    # price_at_sale snapshot (unlike the Phase 1 backfill, which had no historical price to
    # work from and used lab_tests.price at backfill time instead).
    sync_visit_tests(new_visit, data['tests'])
    sync_transaction_line_items(new_transaction, data['tests'], data.get('prices', []))
    db.session.commit()

    return jsonify({'success': True, 'message': 'Transaction and Visit recorded successfully!'})
    
@app.route('/api/visits', methods=['GET'])
def get_all_visits():
    """Fetches historical test orders for the Dashboard.

    Bulk-fetches everything up front instead of the old per-visit
    get_visit_test_names()/get_completed_test_names()/get_visit_report_url()/
    Client.query.get() calls, which each ran their own query PER VISIT — ~4 round-trips
    per row, or tens of thousands of queries total at real data volume (measured ~47s for
    ~5k visits). This does the same job in a handful of queries regardless of row count.

    Supports optional pagination + filtering via ?page=&per_page=&status=&date_from=&
    date_to=&gender=&search= — omit `page` to get the full unfiltered list exactly as
    before (still used by loadInitialData() for dashboard KPI counts, the demand chart, and
    per-patient visit history, all of which need the complete dataset).
    """
    query = PatientVisit.query

    status = request.args.get('status')
    if status:
        query = query.filter(PatientVisit.status == status)

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    if date_from:
        query = query.filter(PatientVisit.date >= date_from)
    if date_to:
        query = query.filter(PatientVisit.date <= date_to + ' 23:59:59')

    gender = request.args.get('gender')
    search = request.args.get('search')
    if gender or search:
        query = query.join(Client, Client.id == PatientVisit.patient_id, isouter=True)
        if gender:
            query = query.filter(Client.gender == gender)
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                PatientVisit.visit_id.ilike(like),
                PatientVisit.patient_name.ilike(like),
                Client.phone.ilike(like),
            ))

    query = query.order_by(PatientVisit.id.desc())

    page = request.args.get('page', type=int)
    total = None
    if page is not None:
        per_page = max(1, min(request.args.get('per_page', 100, type=int), 500))
        total = query.count()
        visits = query.offset((page - 1) * per_page).limit(per_page).all()
    else:
        visits = query.all()

    visit_ids = [v.id for v in visits]
    patient_ids = {v.patient_id for v in visits}

    clients_by_id = {c.id: c for c in Client.query.filter(Client.id.in_(patient_ids)).all()}

    # Booked tests per visit, in booking order — (lab_test_id, name) pairs.
    visit_test_rows = (db.session.query(VisitTest.visit_id, VisitTest.lab_test_id, LabTest.name)
                        .join(LabTest, VisitTest.lab_test_id == LabTest.id)
                        .filter(VisitTest.visit_id.in_(visit_ids))
                        .order_by(VisitTest.visit_id, VisitTest.position)
                        .all())
    tests_by_visit = {}
    for v_id, lab_test_id, name in visit_test_rows:
        tests_by_visit.setdefault(v_id, []).append((lab_test_id, name))

    # Which (visit_id, lab_test_id) pairs have at least one saved result.
    completed_pairs = set(
        db.session.query(TestResult.visit_id, TestResult.lab_test_id)
        .filter(TestResult.visit_id.in_(visit_ids), TestResult.lab_test_id.isnot(None))
        .distinct()
        .all()
    )

    # Report paths per visit, in upload order.
    report_rows = (VisitReport.query
                   .filter(VisitReport.visit_id.in_(visit_ids))
                   .order_by(VisitReport.visit_id, VisitReport.id)
                   .all())
    reports_by_visit = {}
    for r in report_rows:
        reports_by_visit.setdefault(r.visit_id, []).append(r.file_path)

    results = []
    for v in visits:
        booked = tests_by_visit.get(v.id, [])
        completed = [name for lab_test_id, name in booked if (v.id, lab_test_id) in completed_pairs]
        patient = clients_by_id.get(v.patient_id)
        report_paths = reports_by_visit.get(v.id)

        results.append({
            'id': v.id,
            'visit_id': v.visit_id,
            'patient_id': v.patient_id,
            'patient_name': v.patient_name,
            'date': v.date,
            'tests': [name for _lab_test_id, name in booked],
            'completed_tests': completed,
            'status': getattr(v, 'status', 'pending') or 'pending',
            'phone': patient.phone if patient else 'N/A',
            'report_url': ','.join(report_paths) if report_paths else None,
        })

    if page is not None:
        return jsonify({
            'items': results,
            'page': page,
            'per_page': per_page,
            'total': total,
            'total_pages': max(1, (total + per_page - 1) // per_page),
        })
    return jsonify(results)

@app.route('/api/visits/<visit_id>/collect', methods=['PUT'])
def collect_sample(visit_id):
    """Updates the status of a specific historical test row."""
    visit = PatientVisit.query.filter_by(visit_id=visit_id).first()
    if visit:
        visit.status = 'collected'
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"error": "Visit not found"}), 404    

@app.route('/api/transactions', methods=['GET'])
def get_all_transactions():
    """Fetches transaction history. Bulk-fetches test names for the returned transactions
    instead of the old per-transaction get_transaction_test_names() query-per-row (same N+1
    pattern fixed in get_all_visits() — see docs/sumV2.md). Supports optional pagination via
    ?page=&per_page=&date_from=&date_to= — omit `page` to get the full unfiltered list
    exactly as before (still used by fetchTransactionsData() for Financial Overview, which
    needs the complete dataset for revenue totals)."""
    query = TransactionList.query

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    if date_from:
        query = query.filter(TransactionList.date >= date_from)
    if date_to:
        query = query.filter(TransactionList.date <= date_to + ' 23:59:59')

    query = query.order_by(TransactionList.id.desc())

    page = request.args.get('page', type=int)
    total = None
    if page is not None:
        per_page = max(1, min(request.args.get('per_page', 100, type=int), 500))
        total = query.count()
        transactions = query.offset((page - 1) * per_page).limit(per_page).all()
    else:
        transactions = query.all()

    transaction_ids = [t.id for t in transactions]
    line_item_rows = (db.session.query(TransactionLineItem.transaction_id, LabTest.name)
                       .join(LabTest, TransactionLineItem.lab_test_id == LabTest.id)
                       .filter(TransactionLineItem.transaction_id.in_(transaction_ids))
                       .order_by(TransactionLineItem.transaction_id, TransactionLineItem.id)
                       .all())
    tests_by_transaction = {}
    for t_id, name in line_item_rows:
        tests_by_transaction.setdefault(t_id, []).append(name)

    t_data = [{
        'id': t.id,
        'transaction_id': t.transaction_id,
        'patient_id': t.patient_id,
        'patient_name': t.patient_name,
        # ADD OR DEFAULT HERE:
        'date': t.date if t.date else "2026-01-01 00:00:00",
        'tests': tests_by_transaction.get(t.id, []),
        'total_price': t.total_price,
        'discount_percentage': t.discount_percentage,
        'payment_method': t.payment_method,
        'final_payment': t.final_payment,
    } for t in transactions]

    if page is not None:
        return jsonify({
            'items': t_data,
            'page': page,
            'per_page': per_page,
            'total': total,
            'total_pages': max(1, (total + per_page - 1) // per_page),
        })
    return jsonify(t_data)

    return jsonify(results)


@app.route('/patient-history/')
def patient_history_empty():
    return "Please provide a valid Patient ID in the URL (e.g., /patient-history/3).", 400

# 2. MOVE THIS ROUTE: Must be above the catch-all
@app.route('/patient-history/<int:patient_id>')
def patient_history(patient_id):
    # 1. Find the patient in the database
    patient = Client.query.get_or_404(patient_id)
    
    # 2. Get all their past visits, sorted by newest first
    visits = PatientVisit.query.filter_by(patient_id=patient_id).order_by(PatientVisit.date.desc()).all()
    
    # 3. Clean up the test names for the HTML template
    for visit in visits:
        visit.formatted_tests = ", ".join(get_visit_test_names(visit.id)) or "No tests recorded"
        visit.report_url = get_visit_report_url(visit.id)
    
    # 4. Send this data to the mobile-friendly HTML page
    return render_template('patient_history.html', patient=patient, visits=visits)


@app.route('/report/<int:visit_id>')
def public_visit_report(visit_id):
    """Public, unauthenticated — what the report's QR code links to."""
    ctx = build_report_context(visit_id)
    if not ctx:
        return "Report not found.", 404
    return render_template('visit_report.html', **ctx)


@app.route('/results-entry/<int:visit_id>')
def results_entry_page(visit_id):
    """Standalone window for entering structured results for a visit's booked tests."""
    if 'user_id' not in session:
        return redirect('/login')
    return send_from_directory(app.static_folder, 'results_entry.html')

from werkzeug.utils import secure_filename

@app.route('/api/upload-report', methods=['POST'])
def upload_report():
    visit_id = request.form.get('visit_id')
    print(f"DEBUG: Searching for visit_id: {visit_id}")
    patient_id = request.form.get('patient_id')
    patient_name = request.form.get('patient_name')
    
    # 1. Grab ALL uploaded files (checking 'reports' or 'file' depending on your JS)
    files = request.files.getlist('reports')
    if not files:
        files = request.files.getlist('file') # Fallback
        
    if not visit_id or visit_id == 'undefined':
        return jsonify({"error": "Invalid Visit ID"}), 400
        
    if not files:
        return jsonify({"error": "No files attached"}), 400
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    upload_dir = os.path.join(base_dir, 'static', 'reports')
    
    if not os.path.exists(upload_dir):
        os.makedirs(upload_dir)
        
    saved_relative_paths = []
    
    # 2. Loop through every uploaded file
    for file in files:
        # Check if the uploaded file ends with .pdf
        if file and file.filename.lower().endswith('.pdf'):
            
            # FIX 1: Replace spaces in the patient name with underscores
            safe_patient_name = "Unknown_Patient"
            if patient_name:
                safe_patient_name = secure_filename(patient_name.replace(' ', '_'))
                
            # FIX 2: Clean the uploaded file name
            safe_original_name = secure_filename(file.filename)
            
            # FIX 3: Failsafe. If the file was named exactly ".pdf", secure_filename 
            # strips the dot leaving just "pdf". We must add ".pdf" back manually!
            if not safe_original_name.lower().endswith('.pdf'):
                safe_original_name += '.pdf'
            
            # Create a unique filename for EACH file to prevent overwriting
            filename = f"{safe_patient_name}_{visit_id}_{safe_original_name}"
            filepath = os.path.join(upload_dir, filename)
            
            file.save(filepath)
            
            relative_path = f"static/reports/{filename}"
            saved_relative_paths.append(relative_path)
            
    # If no valid PDFs were found in the loop
    if not saved_relative_paths:
        return jsonify({"error": "No valid PDF files found"}), 400
        
    visit = PatientVisit.query.filter_by(visit_id=visit_id).first()
    if visit:
        visit.status = 'results_delivered_by_link'

        patient = Client.query.get(visit.patient_id)
        patient_phone = None

        if patient:
            patient.sample_status = 'delivered'
            patient_phone = patient.phone

        # 3. Save the new report(s) — appends to whatever this visit already has
        add_visit_reports(visit, saved_relative_paths)
        db.session.commit()

        # Return ALL URLs (old and new) so the WhatsApp message includes everything
        all_current_urls = [r.file_path for r in VisitReport.query.filter_by(visit_id=visit.id).order_by(VisitReport.id).all()]

        # 4. Return the list of urls and the patient_id back to Javascript!
        return jsonify({
            "success": True, 
            "message": "Status updated to delivered",
            "report_urls": all_current_urls, # Sends the complete combined list back
            "phone": patient_phone,
            "patient_id": patient_id
        })
    else:
        return jsonify({"error": "Visit not found"}), 404


@app.route('/api/warehouse', methods=['GET'])
@require_permission('warehouse')
def get_warehouse():
    items = WarehouseItem.query.all()
    today = date.today()
    expired_item_ids = {
        b.item_id for b in WarehouseBatch.query.filter_by(status='active').all()
        if b.expiry_date < today
    }
    return jsonify([{
        'id': i.id, 'name': i.name, 'category': i.category,
        'quantity': i.quantity, 'critical_level': i.critical_level, 'unit': i.unit,
        'updated_at': i.updated_at.strftime("%Y-%m-%d") if i.updated_at else "",
        'has_expired_batch': i.id in expired_item_ids,
    } for i in items])

@app.route('/api/warehouse', methods=['POST'])
@require_permission('warehouse')
def save_warehouse_item():
    data = request.json
    item_id = data.get('id')

    if item_id:
        item = WarehouseItem.query.get(item_id)
        if not item: return jsonify({'error': 'Item not found'}), 404
        item.name = data['name']
        item.category = data['category']
        item.quantity = int(data['quantity'])
        item.critical_level = int(data.get('critical_level', 5))
        item.unit = data.get('unit', '')
    else:
        item = WarehouseItem(
            name=data['name'], category=data['category'],
            quantity=int(data['quantity']), critical_level=int(data.get('critical_level', 5)),
            unit=data.get('unit', '')
        )
        db.session.add(item)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/warehouse/<int:item_id>', methods=['DELETE'])
@require_permission('warehouse')
def delete_warehouse_item(item_id):
    item = WarehouseItem.query.get(item_id)
    if item:
        db.session.delete(item)
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404

# --- WAREHOUSE BILLS ROUTES ---
@app.route('/api/warehouse/bills', methods=['GET'])
@require_permission('warehouse')
def get_warehouse_bills():
    bills = WarehouseBill.query.order_by(WarehouseBill.id.desc()).all()
    received_bill_ids = {
        b.bill_id for b in WarehouseBatch.query.filter(WarehouseBatch.bill_id.isnot(None)).all()
    }
    return jsonify([{
        'id': b.id, 'order_id': b.order_id, 'item_id': b.item_id, 'item_name': b.item_name,
        'present_stock': b.present_stock, 'ordered_stock': b.ordered_stock, 'unit': b.unit,
        'price_per_unit': b.price_per_unit, 'total_price': b.total_price, 'category': b.category,
        'user': b.user, 'date_time': b.date_time, 'status': b.status,
        'work_order_id': b.work_order_id,
        'received': b.id in received_bill_ids,
    } for b in bills])

@app.route('/api/warehouse/bills', methods=['POST'])
@require_permission('warehouse')
def create_warehouse_bill():
    data = request.json
    bill = WarehouseBill(
        order_id=data['order_id'], item_id=data['item_id'], item_name=data['item_name'],
        present_stock=data['present_stock'], ordered_stock=data['ordered_stock'],
        unit=data['unit'], price_per_unit=data['price_per_unit'], total_price=data['total_price'],
        category=data['category'], user=data['user'], date_time=data['date_time'], status='demanded'
    )
    db.session.add(bill)
    db.session.commit()
    return jsonify({'success': True})

WAREHOUSE_BILL_STATUSES = {'demanded', 'ordered', 'delivered'}

def _is_admin_or_master():
    role = (session.get('role') or '').lower()
    user_id = str(session.get('user_id', ''))
    return role == 'admin' or user_id.startswith('master_')

@app.route('/api/warehouse/bills/<int:bill_id>/status', methods=['PUT'])
@require_permission('warehouse')
def update_bill_status(bill_id):
    """Any warehouse user can move a bill to 'demanded' or 'delivered' — marking stock as
    physically delivered is a routine receiving-desk action. 'ordered' ("Confirmed") stays
    admin-only: it's the actual purchase sign-off, the one step in this lifecycle someone
    other than an admin shouldn't be able to grant themselves."""
    data = request.json or {}
    new_status = data.get('status')
    if new_status not in WAREHOUSE_BILL_STATUSES:
        return jsonify({'error': f"Invalid status — must be one of {sorted(WAREHOUSE_BILL_STATUSES)}"}), 400
    if new_status == 'ordered' and not _is_admin_or_master():
        return jsonify({'error': 'Only admins can confirm (mark as ordered) a bill'}), 403
    bill = WarehouseBill.query.get(bill_id)
    if not bill: return jsonify({'error': 'Bill not found'}), 404

    bill.status = new_status
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/warehouse/bulk-bills', methods=['POST'])
@require_permission('warehouse')
def create_bulk_bill():
    """Bulk-creates one WarehouseBill per selected item, all sharing one work_order_id, so
    they display/print together in Bills History as a single "New Bill — N items" record
    instead of N separate ones. Reuses the exact same fields/status ('demanded') as a
    single-item quick order (create_warehouse_bill()) — this is just several of those
    grouped, triggered from the "New Bill" button on the Warehouse screen."""
    data = request.json or {}
    items = data.get('items', [])
    if not items:
        return jsonify({'error': 'No items selected'}), 400

    now = datetime.utcnow()
    work_order_id = 'BB-' + now.strftime('%Y%m%d%H%M%S')
    user = data.get('user', 'Unknown User')
    date_time = data.get('date_time') or now.strftime('%Y-%m-%d %H:%M:%S')

    created = []
    for entry in items:
        item = WarehouseItem.query.get(entry.get('item_id'))
        if not item:
            continue
        ordered_stock = int(entry.get('quantity', 0))
        if ordered_stock <= 0:
            continue
        price_per_unit = float(entry.get('price_per_unit', 0))

        bill = WarehouseBill(
            order_id=f"{work_order_id}-{item.id}",
            item_id=item.id, item_name=item.name,
            present_stock=item.quantity, ordered_stock=ordered_stock,
            unit=item.unit, price_per_unit=price_per_unit,
            total_price=round(price_per_unit * ordered_stock, 2),
            category=item.category, user=user, date_time=date_time,
            status='demanded', work_order_id=work_order_id,
        )
        db.session.add(bill)
        created.append(bill)

    if not created:
        return jsonify({'error': 'No valid items to order'}), 400

    db.session.commit()
    return jsonify({'success': True, 'work_order_id': work_order_id, 'items_count': len(created)})

@app.route('/api/warehouse/bulk-bills/<bulk_bill_id>/status', methods=['PUT'])
@require_permission('warehouse')
def update_bulk_bill_status(bulk_bill_id):
    """Updates every bill in a bulk bill at once — see update_bill_status() for the
    per-bill equivalent and the demanded/delivered-vs-ordered permission split."""
    data = request.json or {}
    new_status = data.get('status')
    if new_status not in WAREHOUSE_BILL_STATUSES:
        return jsonify({'error': f"Invalid status — must be one of {sorted(WAREHOUSE_BILL_STATUSES)}"}), 400
    if new_status == 'ordered' and not _is_admin_or_master():
        return jsonify({'error': 'Only admins can confirm (mark as ordered) a bill'}), 403
    bills = WarehouseBill.query.filter_by(work_order_id=bulk_bill_id).all()
    if not bills:
        return jsonify({'error': 'Bill not found'}), 404

    for bill in bills:
        bill.status = new_status

    db.session.commit()
    return jsonify({'success': True, 'items_updated': len(bills)})

# --- WAREHOUSE BATCHES (expiry-dated stock received against a delivered bill) ---
@app.route('/api/warehouse/bills/<int:bill_id>/receive', methods=['POST'])
@require_permission('warehouse')
def receive_warehouse_bill(bill_id):
    """Logs a delivered bill into the warehouse as a dated batch: the technician enters the
    expiry date once for the whole delivered quantity, a barcode is minted for that batch,
    and only now does WarehouseItem.quantity actually increase — this replaces the old
    auto-increment that used to fire the instant a bill was marked 'delivered'."""
    data = request.json or {}
    bill = WarehouseBill.query.get(bill_id)
    if not bill:
        return jsonify({'error': 'Bill not found'}), 404
    if bill.status != 'delivered':
        return jsonify({'error': 'Bill must be marked Delivered before receiving into warehouse'}), 400
    if WarehouseBatch.query.filter_by(bill_id=bill.id).first():
        return jsonify({'error': 'This bill has already been received into warehouse'}), 400

    expiry_raw = data.get('expiry_date')
    if not expiry_raw:
        return jsonify({'error': 'Expiry date is required'}), 400
    try:
        expiry_date = datetime.strptime(expiry_raw, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'Expiry date must be in YYYY-MM-DD format'}), 400

    quantity_received = int(data.get('quantity_received') or bill.ordered_stock or 0)
    if quantity_received <= 0:
        return jsonify({'error': 'Quantity received must be greater than zero'}), 400

    item = WarehouseItem.query.get(bill.item_id)
    if not item:
        return jsonify({'error': 'Warehouse item not found'}), 404

    batch = WarehouseBatch(
        item_id=item.id, bill_id=bill.id, item_name=item.name, unit=item.unit, category=item.category,
        barcode='PENDING', expiry_date=expiry_date, quantity_received=quantity_received,
        quantity_remaining=quantity_received, status='active',
        received_by=session.get('username'),
    )
    db.session.add(batch)
    db.session.flush()  # populates batch.id for the barcode token
    batch.barcode = f"WB-{batch.id:06d}-{secrets.token_hex(3)}"

    item.quantity += quantity_received
    db.session.commit()

    return jsonify({
        'success': True, 'batch_id': batch.id, 'barcode': batch.barcode,
        'item_name': item.name, 'expiry_date': expiry_date.isoformat(),
        'quantity_received': quantity_received,
    })

@app.route('/api/warehouse/batches', methods=['GET'])
@require_permission('warehouse')
def get_warehouse_batches():
    query = WarehouseBatch.query
    item_id = request.args.get('item_id')
    if item_id:
        query = query.filter_by(item_id=int(item_id))
    if request.args.get('expired_only') == 'true':
        query = query.filter_by(status='active').filter(WarehouseBatch.expiry_date < date.today())
    batches = query.order_by(WarehouseBatch.expiry_date.asc()).all()
    today = date.today()
    return jsonify([{
        'id': b.id, 'item_id': b.item_id, 'item_name': b.item_name, 'unit': b.unit, 'category': b.category,
        'barcode': b.barcode, 'expiry_date': b.expiry_date.isoformat(),
        'quantity_received': b.quantity_received, 'quantity_remaining': b.quantity_remaining,
        'status': b.status, 'is_expired': b.status == 'active' and b.expiry_date < today,
        'received_by': b.received_by,
        'received_at': b.received_at.strftime('%Y-%m-%d %H:%M') if b.received_at else '',
    } for b in batches])

@app.route('/api/warehouse/batches/<int:batch_id>/dispose', methods=['POST'])
@admin_required
def dispose_warehouse_batch(batch_id):
    """Admin-confirmed disposal for an expired, quarantined batch — the only way an expired
    batch's remaining quantity leaves stock (expired batches are already hard-excluded from
    normal FEFO withdrawal availability; see scan_work_order_batch() below)."""
    data = request.json or {}
    batch = WarehouseBatch.query.get(batch_id)
    if not batch:
        return jsonify({'error': 'Batch not found'}), 404
    if batch.status != 'active':
        return jsonify({'error': 'Batch is not active'}), 400
    if batch.expiry_date >= date.today():
        return jsonify({'error': 'This batch has not expired yet'}), 400
    reason = (data.get('reason') or '').strip()
    if not reason:
        return jsonify({'error': 'A disposal reason is required'}), 400

    item = WarehouseItem.query.get(batch.item_id)
    disposed_qty = batch.quantity_remaining
    if item:
        item.quantity -= disposed_qty

    batch.status = 'disposed'
    batch.quantity_remaining = 0
    batch.disposed_by = session.get('username')
    batch.disposed_at = datetime.utcnow()
    batch.disposal_reason = reason
    db.session.commit()

    log_activity(
        'update', resource='warehouse_batch', resource_id=batch.id,
        description=(
            f"Disposed {disposed_qty} {batch.unit or ''} of {batch.item_name} "
            f"(batch {batch.barcode}, expired {batch.expiry_date}) — reason: {reason}"
        ),
    )
    return jsonify({'success': True, 'disposed_quantity': disposed_qty})

# --- WAREHOUSE WORK ORDERS (issuing/using up stock, not purchasing more of it) ---
@app.route('/api/warehouse/work-orders', methods=['GET'])
@require_permission('warehouse')
def get_work_orders():
    rows = WarehouseWorkOrder.query.order_by(WarehouseWorkOrder.id.desc()).all()
    return jsonify([{
        'id': r.id, 'work_order_id': r.work_order_id, 'item_id': r.item_id, 'item_name': r.item_name,
        'quantity': r.quantity, 'unit': r.unit, 'category': r.category,
        'user': r.user, 'date_time': r.date_time,
        'status': r.status, 'quantity_fulfilled': r.quantity_fulfilled,
        'approved_by': r.approved_by,
        'approved_at': r.approved_at.strftime('%Y-%m-%d %H:%M') if r.approved_at else '',
    } for r in rows])

@app.route('/api/warehouse/work-orders', methods=['POST'])
@require_permission('warehouse')
def create_work_order():
    """Records a request to issue the given quantities out of warehouse stock — stock is NOT
    touched here. An admin must approve the request (see approve_work_order()) before any of
    it can be fulfilled, and fulfillment only ever happens one unit at a time via a
    successful barcode scan against a WarehouseBatch (see scan_work_order_batch()). A
    requested quantity may legitimately exceed current stock — that's not a constraint until
    scan time, so it isn't validated here."""
    data = request.json or {}
    items = data.get('items', [])
    if not items:
        return jsonify({'error': 'No items selected'}), 400

    resolved = []
    for entry in items:
        item = WarehouseItem.query.get(entry.get('item_id'))
        if not item:
            continue
        quantity = int(entry.get('quantity', 0))
        if quantity <= 0:
            continue
        resolved.append((item, quantity))

    if not resolved:
        return jsonify({'error': 'No valid items to issue'}), 400

    now = datetime.utcnow()
    work_order_id = 'WO-' + now.strftime('%Y%m%d%H%M%S')
    user = data.get('user', 'Unknown User')
    date_time = data.get('date_time') or now.strftime('%Y-%m-%d %H:%M:%S')

    for item, quantity in resolved:
        db.session.add(WarehouseWorkOrder(
            work_order_id=work_order_id, item_id=item.id, item_name=item.name,
            quantity=quantity, unit=item.unit, category=item.category,
            user=user, date_time=date_time, status='requested', quantity_fulfilled=0,
        ))

    db.session.commit()
    return jsonify({'success': True, 'work_order_id': work_order_id, 'items_count': len(resolved)})

@app.route('/api/warehouse/work-orders/<work_order_id>/approve', methods=['PUT'])
@admin_required
def approve_work_order(work_order_id):
    lines = WarehouseWorkOrder.query.filter_by(work_order_id=work_order_id, status='requested').all()
    if not lines:
        return jsonify({'error': 'No requested lines found for this work order'}), 404
    for line in lines:
        line.status = 'approved'
        line.approved_by = session.get('username')
        line.approved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({'success': True, 'items_updated': len(lines)})

@app.route('/api/warehouse/work-orders/<work_order_id>/reject', methods=['PUT'])
@admin_required
def reject_work_order(work_order_id):
    lines = WarehouseWorkOrder.query.filter_by(work_order_id=work_order_id, status='requested').all()
    if not lines:
        return jsonify({'error': 'No requested lines found for this work order'}), 404
    for line in lines:
        line.status = 'rejected'
        line.approved_by = session.get('username')
        line.approved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({'success': True, 'items_updated': len(lines)})

@app.route('/api/warehouse/work-orders/<work_order_id>/scan', methods=['POST'])
@require_permission('warehouse')
def scan_work_order_batch(work_order_id):
    """Fulfills one unit of an approved work-order line by scanning a batch barcode.
    Two independent rules are enforced before any stock is touched:
    (1) an expired batch is hard-blocked, never just warned — it's already excluded from
        normal availability and should go through the disposal flow instead;
    (2) a FEFO violation (an older, still-available batch of the same item exists) is a soft
        warning: returns 409 without mutating anything unless the caller explicitly resends
        with confirm_fefo_override=true, in which case it's allowed through but flagged on
        the scan's audit row."""
    data = request.json or {}
    barcode = (data.get('barcode') or '').strip()
    confirm_override = bool(data.get('confirm_fefo_override'))
    if not barcode:
        return jsonify({'error': 'Barcode is required'}), 400

    batch = WarehouseBatch.query.filter_by(barcode=barcode).first()
    if not batch:
        return jsonify({'error': 'Unknown barcode'}), 404
    if batch.status != 'active':
        return jsonify({'error': f'This batch is {batch.status} and cannot be used'}), 400

    today = date.today()
    if batch.expiry_date < today:
        return jsonify({'error': 'This batch is expired — flagged for disposal review, not usable for fulfillment'}), 400

    line = WarehouseWorkOrder.query.filter_by(
        work_order_id=work_order_id, item_id=batch.item_id, status='approved'
    ).first()
    if not line:
        return jsonify({'error': 'No approved work-order line for this item on this work order'}), 400
    if line.quantity_fulfilled >= line.quantity:
        return jsonify({'error': 'This line is already fully fulfilled'}), 400

    older_available_batch = WarehouseBatch.query.filter(
        WarehouseBatch.item_id == batch.item_id,
        WarehouseBatch.id != batch.id,
        WarehouseBatch.status == 'active',
        WarehouseBatch.quantity_remaining > 0,
        WarehouseBatch.expiry_date >= today,
        WarehouseBatch.expiry_date < batch.expiry_date,
    ).first()

    fefo_violation = older_available_batch is not None
    if fefo_violation and not confirm_override:
        return jsonify({
            'fefo_warning': True,
            'message': 'check shelf for older item of the same name please!',
            'older_batch_expiry': older_available_batch.expiry_date.isoformat(),
        }), 409

    item = WarehouseItem.query.get(batch.item_id)
    batch.quantity_remaining -= 1
    if batch.quantity_remaining <= 0:
        batch.status = 'exhausted'
    if item:
        item.quantity -= 1
    line.quantity_fulfilled += 1
    line_complete = line.quantity_fulfilled >= line.quantity
    if line_complete:
        line.status = 'completed'

    db.session.add(WarehouseWorkOrderScan(
        work_order_line_id=line.id, batch_id=batch.id,
        scanned_by=session.get('username'), fefo_violation=fefo_violation,
    ))
    db.session.commit()

    return jsonify({
        'success': True, 'item_name': batch.item_name,
        'quantity_remaining_in_batch': batch.quantity_remaining,
        'line_fulfilled': line.quantity_fulfilled, 'line_requested': line.quantity,
        'line_complete': line_complete,
    })

@app.route('/api/hr/employees', methods=['GET'])
@require_permission('hr-management')
def get_employees():
    employees = Employee.query.all()
    result = []
    current_time = time.time()
    
    for emp in employees:
        emp_dict = emp.to_dict()
        
        # Get the username linked to this employee
        username = getattr(emp, 'username', None)
        presence = 'offline' # Default fallback
        
        # If they have a username, check if they are currently pinging the server
        if username and username in PRESENCE_STORE:
            user_data = PRESENCE_STORE[username]
            
            # If the server hasn't heard from them in 16+ mins, assume they closed the browser abruptly
            if current_time - user_data['last_seen'] > PRESENCE_TIMEOUT_SECONDS:
                presence = 'offline'
            else:
                presence = user_data['status']
                
        # Attach the live presence to the dictionary before sending to Javascript
        emp_dict['presence_status'] = presence
        result.append(emp_dict)
        
    return jsonify(result)

@app.route('/api/hr/employees', methods=['POST'])
@require_permission('hr-management')
def save_employee():
    data = request.json
    emp_id = data.get('id')
    
    # Parse date
    join_date_str = data.get('join_date')
    parsed_date = datetime.utcnow()
    if join_date_str:
        try:
            parsed_date = datetime.strptime(join_date_str, '%Y-%m-%d')
        except:
            pass

    if emp_id:
        emp = db.session.get(Employee, emp_id)
        if not emp: return jsonify({'error': 'Employee not found'}), 404
        
        # Update existing fields
        emp.name = data.get('name')
        emp.role = data.get('role')
        emp.phone = data.get('phone')
        emp.salary = float(data.get('salary', 0))
        emp.status = data.get('status', 'Active')
        
        # 🚨 NEW ASSIGNMENTS
        emp.email = data.get('email')
        emp.join_date = parsed_date
        emp.username = data.get('username') # <-- Add this line!
        
    else:
        # Create new
        emp = Employee(
            name=data.get('name'),
            role=data.get('role'),
            phone=data.get('phone'),
            salary=float(data.get('salary', 0)),
            status=data.get('status', 'Active'),
            # 🚨 NEW ASSIGNMENTS
            email=data.get('email'),
            join_date=parsed_date,
            username=data.get('username') # <-- Add this line!
        )
        db.session.add(emp)
    
    print(f"DEBUG: Saving email '{emp.email}' and username '{emp.username}' for employee {emp.name}")    
    db.session.commit()
    return jsonify({'success': True, 'message': 'Employee saved!'})

@app.route('/api/hr/employees/<int:emp_id>', methods=['DELETE'])
@require_permission('hr-management')
def delete_employee(emp_id):
    emp = db.session.get(Employee, emp_id)
    if emp:
        db.session.delete(emp)
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404



@app.route('/api/hr/employees/email', methods=['POST'])
@require_permission('hr-management')
def send_hr_email():
    data = request.json
    emails = data.get('emails', [])
    subject = data.get('subject', '')
    message = data.get('message', '')

    if not emails:
        return jsonify({"error": "No email addresses provided"}), 400

    if not is_email_configured():
        return jsonify({
            "error": "Email isn't configured yet. Set SMTP_HOST, SMTP_USERNAME, and "
                     "SMTP_PASSWORD (optionally SMTP_PORT and SMTP_FROM) as environment "
                     "variables for the server process, then restart it.",
        }), 501

    sent, failed = [], []
    for email_address in emails:
        try:
            send_email(email_address, subject, message)
            sent.append(email_address)
        except Exception as e:
            print(f"Failed to send HR email to {email_address}: {e}")
            failed.append(email_address)

    return jsonify({
        "success": len(sent) > 0,
        "sent": len(sent),
        "failed": failed,
        "message": f"Sent to {len(sent)} of {len(emails)} recipient(s).",
    })

@app.route('/api/workspace/change', methods=['POST'])
def change_workspace():
    data = request.json
    new_workspace = data.get('workspace')
    current_username = session.get('username')

    # 1. Security Check: Only allow if user is in admins.json
    is_authorized = False
    if os.path.exists('admins.json'):
        with open('admins.json', 'r') as f:
            try:
                admins = json.load(f)
                if current_username in admins:
                    is_authorized = True
            except:
                pass
    
    if not is_authorized:
        return jsonify({'error': 'Unauthorized - Master Access Only'}), 403

    # 2. Update the session workspace
    if new_workspace in ['clinic', 'lab']:
        session['workspace'] = new_workspace
        return jsonify({'success': True, 'workspace': new_workspace})
    
    return jsonify({'error': 'Invalid workspace'}), 400

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_app(path):
    if path == "":
        workspace = session.get('workspace', 'clinic')
        path = "index_lab.html" if workspace == 'lab' else "index.html"
    
    # FIX: Prevent the dashboard "flash" by checking the session on the backend
    # before we ever send the index.html/index_lab.html file to the browser!
    if (path == "index.html" or path == "index_lab.html") and 'user_id' not in session:
        return redirect('/login')
    
    requested_path = os.path.join(app.static_folder, path)

    # Serve static files natively (CSS, JS, Images)
    if os.path.exists(requested_path):
        return send_from_directory(app.static_folder, path)
    
    # Fallback routing
    if 'user_id' in session:
        workspace = session.get('workspace', 'clinic')
        return send_from_directory(app.static_folder, "index_lab.html" if workspace == 'lab' else "index.html")
    return redirect('/login')


       
    # return jsonify({"error": "Invalid file type"}), 400
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('BACKEND_PORT', 9050)))
