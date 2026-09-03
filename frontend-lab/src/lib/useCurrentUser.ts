import { useEffect, useState } from 'react';
import { apiFetch } from './apiFetch';

export interface CurrentUser {
  id: number | string;
  username: string;
  role: string;
  permissions: string[];
}

// No React island has needed to know the logged-in user's role/permissions client-side
// until now — script_lab.js's own `currentUser` (script_lab.js:12) is a `let`, not a real
// `function` declaration, so unlike the globals in globals.d.ts it is NOT reachable as
// window.currentUser from this separate bundle (see that file's header comment for why that
// distinction matters). This hook fetches its own copy from the same endpoint
// (GET /api/auth/current_user) script_lab.js's main() already calls, instead of adding a
// vanilla-side bridge for something that's cheap to just re-fetch.
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/auth/current_user')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch current user');
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setUser({
          id: data.id,
          username: data.username,
          role: data.role,
          permissions: typeof data.permissions === 'string'
            ? data.permissions.split(',').map((p: string) => p.trim()).filter(Boolean)
            : data.permissions || [],
        });
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Matches require_permission()'s own bypass check (src/main.py:399) — role 'admin' always
  // passes every permission gate (master accounts are also returned with role: 'admin', see
  // GET /api/auth/current_user's master-account branch in src/routes/user.py).
  const isAdmin = user?.role === 'admin';

  return { user, loading, isAdmin };
}
