import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { useCurrentUser } from '../../lib/useCurrentUser';

interface SecurityUser {
  id: number;
  username: string;
  role: string;
  permissions: string;
}

interface PermissionOption {
  key: string;
  label: string;
}

// Mirrors the vanilla openAccessModal()'s auto-generation (script_lab.js:6113-6148): one
// checkbox per sidebar nav-tab, read live from the still-vanilla sidebar (index_lab.html)
// rather than a hardcoded list, so a future tab needs no changes here.
function readTabPermissionOptions(): PermissionOption[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.nav-tab[data-tab]'))
    .map((tab) => {
      const key = tab.getAttribute('data-tab') || '';
      const label = tab.querySelector('span:last-child')?.textContent?.trim() || key;
      return { key, label };
    })
    .filter((opt) => opt.key);
}

export default function SecurityRBACTab() {
  const { t } = useTranslations();
  const { isAdmin } = useCurrentUser();

  const [users, setUsers] = useState<SecurityUser[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('admin');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [modalUser, setModalUser] = useState<SecurityUser | null>(null);
  const [modalOptions, setModalOptions] = useState<PermissionOption[]>([]);
  const [modalSelected, setModalSelected] = useState<Set<string>>(new Set());
  const [savingPermissions, setSavingPermissions] = useState(false);

  function loadUsers() {
    setRefreshTick((n) => n + 1);
  }

  // Fetched on mount and after every write — a one-shot fetch with no runaway background
  // cost, same as SettingsTab's fetch-on-mount (unlike ActivityLogTab's gated polling).
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/auth/users')
      .then((res) => (res.ok ? (res.json() as Promise<SecurityUser[]>) : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        setUsers(data);
        setLoadError(false);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newUsername || !newPassword) {
      window.showAlert(t('alerts.fill_all_fields', 'Please fill in all fields'), 'warn');
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      const result = await res.json();
      if (!res.ok) {
        window.showAlert(result.error || t('alerts.user_create_failed', 'Failed to create user'), 'error');
        return;
      }
      setNewUsername('');
      setNewPassword('');
      window.showAlert(t('alerts.user_created', 'User created successfully!'), 'success');
      loadUsers();
    } catch {
      window.showAlert(t('alerts.server_connect_failed', 'Failed to connect to server.'), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(user: SecurityUser) {
    if (!window.confirm(t('alerts.confirm_delete_user', 'Are you sure you want to delete this user?'))) return;
    setDeletingId(user.id);
    try {
      const res = await apiFetch(`/api/auth/users/${user.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      window.showAlert(t('alerts.user_deleted', 'User deleted.'), 'success');
      loadUsers();
    } catch {
      window.showAlert(t('alerts.user_delete_error', 'Error deleting user.'), 'error');
    } finally {
      setDeletingId(null);
    }
  }

  function openAccessModal(user: SecurityUser) {
    // EXTRA_PERMISSIONS equivalent (script_lab.js:6109-6111) — gates a specific action
    // rather than a whole sidebar tab, so it can't be auto-generated from .nav-tab elements.
    const options = [
      ...readTabPermissionOptions(),
      { key: 'approve_results', label: t('alerts.approve_results_permission', 'Approve Pending Results (Check)') },
    ];
    setModalOptions(options);
    setModalSelected(new Set(user.permissions ? user.permissions.split(',').filter(Boolean) : []));
    setModalUser(user);
  }

  function toggleModalPermission(key: string, checked: boolean) {
    setModalSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function handleSavePermissions() {
    if (!modalUser) return;
    setSavingPermissions(true);
    try {
      const res = await apiFetch(`/api/auth/users/${modalUser.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: [...modalSelected].join(',') }),
      });
      if (!res.ok) throw new Error('Failed to save');
      window.showAlert(t('alerts.permissions_updated', 'Permissions updated!'), 'success');
      setModalUser(null);
      loadUsers();
    } catch {
      window.showAlert(t('alerts.server_connect_failed', 'Failed to connect to server.'), 'error');
    } finally {
      setSavingPermissions(false);
    }
  }

  if (loadError) {
    return <p style={{ color: 'var(--warn)', padding: 20 }}>Could not connect to database.</p>;
  }

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <h1>{t('security.title', 'Security & Access')}</h1>
        <p style={{ color: 'var(--muted)' }}>
          {t('security.subtitle', 'Manage system users, roles, and per-user tab permissions')}
        </p>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ color: 'var(--text)', marginBottom: 15 }}>
          {t('settings.user_mgt', 'User Management & Permissions')}
        </h3>

        {!isAdmin && (
          <p style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 12 }}>
            {t('settings.no_settings_permission', 'You do not have permission to change settings.')}
          </p>
        )}

        <form
          onSubmit={handleCreate}
          style={{ display: 'flex', gap: 15, marginBottom: 20, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
              {t('settings.username', 'Username')}
            </label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={!isAdmin}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
              {t('settings.password', 'Password')}
            </label>
            <input
              type="password"
              style={{ width: '100%' }}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={!isAdmin}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
              {t('settings.role', 'Role')}
            </label>
            <select style={{ width: '100%' }} value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={!isAdmin}>
              <option value="admin">{t('roles.admin', 'Admin')}</option>
              <option value="user">{t('roles.User', 'User')}</option>
            </select>
          </div>
          <button
            type="submit"
            className="btn"
            style={{ background: 'var(--teal)', color: '#04121d' }}
            disabled={!isAdmin || creating}
          >
            {t('settings.add_user', 'Add User')}
          </button>
        </form>

        <div className="table-container glass-panel">
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('settings.table_username', 'Username')}</th>
                <th>{t('settings.table_role', 'Role')}</th>
                <th style={{ textAlign: 'right' }}>{t('table_headers.action', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                    {t('alerts.empty_no_users', 'No users found.')}
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.username}</strong>
                    </td>
                    <td>{u.role}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn ghost" onClick={() => openAccessModal(u)} disabled={!isAdmin}>
                        {t('settings.manage_access', 'Manage Access')}
                      </button>
                      {u.role !== 'lab_master' && (
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ color: '#ef4444', marginLeft: 8 }}
                          onClick={() => handleDelete(u)}
                          disabled={!isAdmin || deletingId === u.id}
                        >
                          {t('actions.delete', 'Delete')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalUser && (
        <div id="security-access-modal" className="modal" style={{ display: 'block' }}>
          <div className="modal-content glass-panel" style={{ maxWidth: 400 }}>
            <span className="close" onClick={() => setModalUser(null)}>
              &times;
            </span>
            <h2 style={{ marginBottom: 20 }}>
              {t('settings.manage_access', 'Manage Access')} — {modalUser.username}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {modalOptions.map((opt) => (
                <label key={opt.key} style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    checked={modalSelected.has(opt.key)}
                    onChange={(e) => toggleModalPermission(opt.key, e.target.checked)}
                  />{' '}
                  {opt.label}
                </label>
              ))}
            </div>
            <button className="btn" onClick={handleSavePermissions} disabled={savingPermissions}>
              {t('settings.save_permissions', 'Save Permissions')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
