import os
import json
import time
from functools import wraps
from flask import Blueprint, request, jsonify, session, current_app
from werkzeug.security import check_password_hash
from src.models.user import User, db
from src.models.junctions import UserPermission, sync_user_permissions, DEFAULT_PERMISSIONS
from src.models.lab_config import LabConfig, is_login_blocked_for_regular_users
from src.utils.audit import log_activity

user_bp = Blueprint('user_bp', __name__)

# @user_bp.route('/register', methods=['POST'])

def login_required(f):
    """Decorator to require a user to be logged in."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({"message": "Authentication required. Please log in."}), 401
        return f(*args, **kwargs)
    return decorated_function

def _mark_online(username):
    """Resets this user's PRESENCE_STORE entry (main.py) to 'online' right when they log in —
    otherwise a stale 'offline'/timed-out flag left over from *any* prior logout (idle-triggered
    or manual) would immediately kill the brand-new session on the very next API call, via the
    offline-enforcement check in before_request_interceptor. Re-login should only ever be
    blocked by the scheduled force_logout_time/login_resume_time window (checked separately
    above), never by presence bookkeeping left over from before this login happened."""
    from src.main import PRESENCE_STORE  # deferred: main.py imports this blueprint at load time
    PRESENCE_STORE[username] = {'status': 'online', 'last_seen': time.time()}


def admin_required(f):
    """Decorator to require a user to be logged in AND be an admin."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({"message": "Authentication required. Please log in."}), 401
        # Roles in the DB are inconsistently cased ('admin' vs 'Admin' vs 'lab_master') —
        # compare case-insensitively so an account isn't locked out by capitalization alone.
        role = (session.get('role') or '').lower()
        user_id = str(session.get('user_id', ''))
        if role != 'admin' and not user_id.startswith('master_'):
            return jsonify({"message": "Access denied. Admin privileges required."}), 403
        return f(*args, **kwargs)
    return decorated_function


# --- Login rate-limiting (in-memory, mirrors the existing PRESENCE_STORE pattern in
# main.py) --- after LOGIN_LOCKOUT_THRESHOLD failed attempts for a username within
# LOGIN_ATTEMPT_WINDOW_SECONDS, further attempts are rejected for LOGIN_LOCKOUT_SECONDS.
# Keyed by the attempted username, not IP — this is a small LAN desk app with a handful of
# accounts, so username-based throttling is the meaningful unit to protect.
LOGIN_ATTEMPTS = {}
LOGIN_LOCKOUT_THRESHOLD = 5
LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60
LOGIN_LOCKOUT_SECONDS = 5 * 60


def _lockout_seconds_remaining(username):
    entry = LOGIN_ATTEMPTS.get(username)
    if not entry or not entry.get('locked_until'):
        return 0
    remaining = entry['locked_until'] - time.time()
    return max(0, int(remaining))


def _record_failed_login(username):
    now = time.time()
    entry = LOGIN_ATTEMPTS.get(username)
    if not entry or now - entry['first_fail_at'] > LOGIN_ATTEMPT_WINDOW_SECONDS:
        entry = {'fails': 0, 'first_fail_at': now, 'locked_until': None}
    entry['fails'] += 1
    if entry['fails'] >= LOGIN_LOCKOUT_THRESHOLD:
        entry['locked_until'] = now + LOGIN_LOCKOUT_SECONDS
    LOGIN_ATTEMPTS[username] = entry


def _clear_failed_login(username):
    LOGIN_ATTEMPTS.pop(username, None)
def register():
    """Register a new user."""
    data = request.get_json()
    if not data or not data.get('username') or not data.get('password') or not data.get('email'):
        return jsonify({"message": "Missing username, email, or password"}), 400

    if User.query.filter_by(username=data['username']).first():
        return jsonify({"message": "Username already exists"}), 409
    
    if User.query.filter_by(email=data['email']).first():
        return jsonify({"message": "Email already exists"}), 409

    role = data.get('role', 'user')
    new_user = User(username=data['username'], email=data['email'], role=role)
    new_user.set_password(data['password'])
    db.session.add(new_user)
    db.session.commit()

    return jsonify({"message": "User registered successfully"}), 201

@user_bp.route('/login', methods=['POST'])
def login():
    """Authenticate a user using prefix-based routing and JSON master accounts."""
    data = request.get_json()
    if not data or not data.get('username') or not data.get('password'):
        return jsonify({"message": "Missing username or password"}), 400

    username = data['username'].lower()
    password = data['password']

    # 0. Lockout check — before touching the DB or admins.json, so a locked-out username
    # can't be used to keep probing which check (prefix/master/DB) rejects it.
    locked_seconds = _lockout_seconds_remaining(username)
    if locked_seconds > 0:
        log_activity('login_failed', resource='auth', status='failed', username=username,
                     description=f"Login blocked — locked out for {locked_seconds}s after repeated failures")
        return jsonify({"message": f"Too many failed attempts. Try again in {locked_seconds} seconds."}), 429

    # 1. Workspace Detection
    if username.startswith('lab_'):
        workspace = 'lab'
    elif username.startswith('clnc_'):
        workspace = 'clinic'
    else:
        _record_failed_login(username)
        log_activity('login_failed', resource='auth', status='failed', username=username,
                     description="Invalid username prefix")
        return jsonify({"message": "Invalid prefix. Use clnc_ or lab_"}), 401

    # 2. Check the JSON Master Admins file FIRST
    json_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'admins.json')
    try:
        with open(json_path, 'r') as f:
            master_admins = json.load(f)

        stored = master_admins.get(username)
        if stored and check_password_hash(stored, password):
            # Login successful as a JSON Master Admin
            session['user_id'] = f"master_{username}" # Special ID for masters
            session['role'] = 'admin'
            session['workspace'] = workspace
            session['username'] = username
            _clear_failed_login(username)
            _mark_online(username)
            log_activity('login', resource='auth', description=f"{username} logged in (master)")
            return jsonify({
                "message": "Master Login successful",
                "user": {"username": username, "role": "admin", "workspace": workspace}
            }), 200
        elif stored:
            # A master account exists with this username, but the password didn't match —
            # count it as a failed attempt and stop here rather than falling through to the
            # DB check (a master username is never also a DB row worth trying).
            _record_failed_login(username)
            log_activity('login_failed', resource='auth', status='failed', username=username,
                         description="Wrong password (master account)")
            return jsonify({"message": "Invalid credentials"}), 401
    except FileNotFoundError:
        print("Warning: admins.json not found. Skipping master auth.")

    # 3. If not a master admin, check the actual database
    # Bind to the correct database engine based on the prefix before querying!
    from flask import current_app

    # Securely point to the correct engine
    if workspace == 'lab':
        db.session.bind = current_app.lab_engine
    else:
        db.session.bind = current_app.clinic_engine

    # IMPORTANT: Use db.session.query to ensure the bind is respected
    user = db.session.query(User).filter_by(username=username).first()

    if user and user.check_password(password):
        # Scheduled access lockout — admins are exempt (see is_login_blocked_for_regular_users
        # docstring); only non-admin accounts are turned away during the configured window.
        if (user.role or '').lower() != 'admin' and is_login_blocked_for_regular_users(LabConfig.get_config()):
            log_activity('login_failed', resource='auth', status='failed', username=username,
                         description=f"{user.username} blocked — outside allowed login hours")
            return jsonify({"message": "System login is disabled for non-admin accounts right now. Try again later."}), 423

        session['user_id'] = user.id
        session['role'] = user.role
        session['workspace'] = workspace
        session['username'] = user.username
        _clear_failed_login(username)
        _mark_online(username)

        user_data = user.to_dict()
        user_data['workspace'] = workspace
        log_activity('login', resource='auth', description=f"{user.username} logged in")
        return jsonify({"message": "Login successful", "user": user_data}), 200

    _record_failed_login(username)
    log_activity('login_failed', resource='auth', status='failed', username=username,
                 description="Wrong password or unknown user")
    return jsonify({"message": "Invalid credentials"}), 401

@user_bp.route('/logout', methods=['POST'])
def logout():
    """Log out the current user by clearing the session."""
    log_activity('logout', resource='auth', description=f"{session.get('username')} logged out")
    session.clear()
    return jsonify({"message": "Logout successful"}), 200

@user_bp.route('/update_workspace', methods=['POST'])
@login_required
def update_workspace():
    """Update the workspace in the session."""
    data = request.get_json()
    workspace = data.get('workspace')
    
    if workspace not in ['clinic', 'lab']:
        return jsonify({"message": "Invalid workspace"}), 400
        
    session['workspace'] = workspace
    return jsonify({"message": f"Workspace updated to {workspace}"}), 200

@user_bp.route('/current_user', methods=['GET'])
def get_current_user():
    """Get details of the currently logged-in user, supporting master accounts."""
    if 'user_id' in session:
        user_id = str(session['user_id'])
        workspace = session.get('workspace', 'clinic')
        
        # 1. Handle JSON Master Accounts
        if user_id.startswith('master_'):
            username = user_id.replace('master_', '')
            return jsonify({
                'id': user_id,
                'username': username,
                'email': f"{username}@master.local",
                'role': 'admin',
                'workspace': workspace,
                'is_active': True,
                # 🚨 CRITICAL FIX 1: Give the master account full permissions explicitly
                'permissions': 'dashboard,patients,tests,samples,reports,financial,warehouse,settings,transactions'
            }), 200
            
        # 2. Handle Regular Database Users
        # Bind the correct database engine based on their workspace!
        if workspace == 'lab':
            db.session.bind = current_app.lab_engine
        else:
            db.session.bind = current_app.clinic_engine
            
        user = User.query.get(session['user_id'])
        if user:
            # Safely get the dictionary
            user_data = user.to_dict() if hasattr(user, 'to_dict') else {
                'id': user.id,
                'username': user.username,
                'role': user.role
            }
            
            user_data['workspace'] = workspace

            # Reads from user_permissions now (Phase 2 cutover) instead of the users.permissions
            # column; to_dict() doesn't include permissions at all, so this always sets it.
            user_data['permissions'] = ','.join(
                p.permission for p in UserPermission.query.filter_by(user_id=user.id).all()
            )

            return jsonify(user_data), 200
            
    return jsonify({"message": "Not authenticated"}), 401

@user_bp.route('/master/create-account', methods=['POST'])
def master_create_account():
    """Create a client/user with an enforced prefix in the target database."""
    if not str(session.get('user_id', '')).startswith('master_'):
        return jsonify({"error": "Unauthorized. Master access required."}), 403
        
    data = request.get_json()
    target_workspace = data.get('target_workspace') # 'clinic' or 'lab'
    raw_username = data.get('username')
    password = data.get('password')
    role = data.get('role', 'user')
    
    # 1. Enforce the prefix
    if target_workspace == 'clinic':
        prefix = 'clnc_'
    else:
        prefix = 'lab_'
        
    final_username = f"{prefix}{raw_username}"
    
    # 2. Bind to the target database
    if target_workspace == 'lab':
        db.session.bind = current_app.lab_engine
    else:
        db.session.bind = current_app.clinic_engine    
    # 3. Check and Create
    try:
        if User.query.filter_by(username=final_username).first():
            return jsonify({"error": f"Username '{final_username}' already exists!"}), 400
            
        new_user = User(username=final_username, email=f"{final_username}@local.com", role=role)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()

        sync_user_permissions(new_user, DEFAULT_PERMISSIONS)
        db.session.commit()

        return jsonify({"message": f"Successfully created user: {final_username}"}), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": f"Database error: {str(e)}"}), 500

@user_bp.route('/master/update-features', methods=['POST'])
def master_update_features():
    """Update which UI features are enabled for a specific workspace."""
    if not str(session.get('user_id', '')).startswith('master_'):
        return jsonify({"error": "Unauthorized. Master access required."}), 403
        
    data = request.get_json()
    target_workspace = data.get('target_workspace')
    active_features = data.get('features', []) # List of strings
    
    # Bind to target database
    from flask import current_app
    from src.models.clinic_config import ClinicConfig
    db.session.bind = current_app.lab_engine if target_workspace == 'lab' else current_app.clinic_engine
    
    config = ClinicConfig.get_config()
    config.active_features = json.dumps(active_features)
    db.session.commit()
    
    return jsonify({"message": f"Successfully updated features for {target_workspace.upper()}"}), 200

# ==========================================
# USER MANAGEMENT (SETTINGS TAB)
# ==========================================

@user_bp.route('/users', methods=['GET'])
@admin_required
def get_settings_users():
    """Fetch all users for the Lab Settings table. Includes each user's current permissions
    (comma-joined, matching the shape savePermissions() PUTs back) — openAccessModal() in
    script_lab.js reads u.permissions to pre-check the right boxes; without this it always
    opened with everything unchecked regardless of what was actually saved."""
    from flask import current_app
    db.session.bind = current_app.lab_engine

    users = User.query.all()
    perms_by_user = {}
    for p in UserPermission.query.filter(UserPermission.user_id.in_([u.id for u in users])).all():
        perms_by_user.setdefault(p.user_id, []).append(p.permission)
    return jsonify([
        {'id': u.id, 'username': u.username, 'role': u.role, 'permissions': ','.join(perms_by_user.get(u.id, []))}
        for u in users
    ])

@user_bp.route('/users', methods=['POST'])
@admin_required
def add_settings_user():
    """Create a new user from the Settings tab."""
    from flask import current_app
    data = request.get_json()
    
    raw_username = data.get('username', '').lower()
    
    # 1. ENFORCE THE PREFIX! (So they can actually log in)
    if not raw_username.startswith('lab_'):
        final_username = f"lab_{raw_username}"
    else:
        final_username = raw_username
        
    db.session.bind = current_app.lab_engine
    
    # 2. Check if user already exists
    if User.query.filter_by(username=final_username).first():
        return jsonify({'error': f"Username {final_username} already exists"}), 400
        
    # 3. Create user securely
    new_user = User(
        username=final_username,
        email=f"{final_username}@medicio-lab.com", 
        role=data.get('role', 'Secretary')
    )
    new_user.set_password(data.get('password'))

    db.session.add(new_user)
    db.session.commit()

    sync_user_permissions(new_user, DEFAULT_PERMISSIONS)
    db.session.commit()

    return jsonify({'success': True, 'message': f'User {final_username} added successfully'})

@user_bp.route('/users/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_settings_user(user_id):
    """Delete a user from the Settings tab."""
    from flask import current_app
    db.session.bind = current_app.lab_engine
    
    user = User.query.get(user_id)
    if user and user.role != 'lab_master':
        db.session.delete(user)
        db.session.commit()
        return jsonify({'success': True})
        
    return jsonify({'error': 'Cannot delete this user'}), 400
