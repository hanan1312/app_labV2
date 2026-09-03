import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { WarehouseBatchRow } from './batchTypes';

interface Props {
  onClose: () => void;
  onDisposed: () => void;
}

export default function ExpiredBatchesModal({ onClose, onDisposed }: Props) {
  const { t } = useTranslations();
  const [batches, setBatches] = useState<WarehouseBatchRow[] | null>(null);
  const [error, setError] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBatches(null);
    setError(false);
    apiFetch('/api/warehouse/batches?expired_only=true')
      .then((res) => (res.ok ? (res.json() as Promise<WarehouseBatchRow[]>) : Promise.reject()))
      .then((json) => {
        if (!cancelled) setBatches(json);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  async function dispose(batch: WarehouseBatchRow) {
    const reason = window.prompt(`Dispose ${batch.quantity_remaining} unit(s) of "${batch.item_name}" — reason for disposal:`);
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      window.showAlert(t('alerts.disposal_reason_required', 'A disposal reason is required.'), 'error');
      return;
    }

    try {
      const res = await apiFetch(`/api/warehouse/batches/${batch.id}/dispose`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        window.showAlert(t('alerts.batch_disposed', 'Disposed {count} unit(s).', { count: body.disposed_quantity }), 'success');
        setRefreshTick((n) => n + 1);
        onDisposed();
      } else {
        window.showAlert(body.error || t('alerts.batch_dispose_failed', 'Failed to dispose batch'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.batch_dispose_error', 'Error disposing batch'), 'error');
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 800 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--danger)' }}>🚩 Review Expired Batches</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
          Expired batches are excluded from FEFO withdrawal. Confirm disposal to remove them from stock.
        </p>

        <div style={{ maxHeight: 450, overflowY: 'auto' }}>
          {batches === null ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>Loading…</p>
          ) : error ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--danger)' }}>Failed to load expired batches.</p>
          ) : batches.length === 0 ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--ok)' }}>✅ No expired batches — nothing to review.</p>
          ) : (
            <div className="table-container">
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Expiry</th>
                    <th>Remaining</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td>
                        {b.item_name}
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.category || ''}</div>
                      </td>
                      <td style={{ color: 'var(--danger)', fontWeight: 'bold' }}>{b.expiry_date}</td>
                      <td>
                        {b.quantity_remaining} <span style={{ fontSize: 11, color: 'var(--muted)' }}>{b.unit || ''}</span>
                      </td>
                      <td>
                        <button type="button" className="btn btn-danger" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => dispose(b)}>
                          🗑 Dispose
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
