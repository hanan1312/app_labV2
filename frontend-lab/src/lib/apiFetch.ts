// TS port of script_lab.js's apiFetch (script_lab.js:405-472), standardized so every
// React island uses one consistent wrapper instead of the mix of apiFetch/raw-fetch call
// sites in the vanilla code. Session auth is a Flask cookie sent automatically on same-origin
// requests (this bundle is always served by Flask itself, see vite.config.ts) — no
// Authorization header or CSRF token involved.
//
// Offline handling reuses the vanilla globals (window.saveToOfflineQueue / window.t /
// window.showAlert) rather than reimplementing the IndexedDB outbox in TypeScript — they're
// real top-level `function` declarations in script_lab.js, so (unlike its `let`/`const`
// globals) they're genuinely reachable as window.* from this separate bundle. This also means
// a write queued from a React island rides the exact same `sync-outbox` store and
// window.addEventListener('online', syncOfflineData) replay-on-reconnect logic that already
// covers every still-vanilla write — no separate sync path to keep in sync.
export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('X-App-Mode', localStorage.getItem('app_workspace') || 'lab');
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const response = await fetch(endpoint, { ...options, headers });
    if (response.status === 401 && endpoint !== '/api/auth/login') {
      window.location.replace('/login');
    }
    return response;
  } catch (error) {
    const isNetworkFailure =
      !navigator.onLine ||
      (error instanceof Error &&
        (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')));
    if (!isNetworkFailure) throw error;

    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      // Skip FormData (e.g. PDF uploads) for now — same limitation as the vanilla queue.
      const payload = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      await window.saveToOfflineQueue(endpoint, method, payload);
      return new Response(
        JSON.stringify({ success: true, message: 'Saved offline. Will sync when connected.' }),
        { status: 200 }
      );
    }
    window.showAlert(window.t('offline_cached_data', 'You are offline. Showing cached data.'), 'info');
    return new Response(JSON.stringify({ error: 'Offline mode', data: [] }), { status: 503 });
  }
}
