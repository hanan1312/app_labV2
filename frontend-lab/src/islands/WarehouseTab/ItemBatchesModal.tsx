import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { batchStatusPillClass, type WarehouseBatchRow } from './batchTypes';
import { printBatchLabel } from './batchLabel';

interface Props {
  itemId: number;
  itemName: string;
  onClose: () => void;
}

export default function ItemBatchesModal({ itemId, itemName, onClose }: Props) {
  const { t } = useTranslations();
  const [batches, setBatches] = useState<WarehouseBatchRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/warehouse/batches?item_id=${itemId}`)
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
  }, [itemId]);

  function statusLabel(batch: WarehouseBatchRow): string {
    if (batch.is_expired) return t('alerts.status_expired_flag', '🚩 Expired');
    if (batch.status === 'disposed') return t('alerts.status_disposed', 'Disposed');
    if (batch.status === 'exhausted') return t('alerts.status_exhausted', 'Exhausted');
    return t('alerts.status_active', 'Active');
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 800 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>🏷 Batches — {itemName}</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>Sorted oldest expiry first — withdraw from the top (FEFO).</p>

        <div style={{ maxHeight: 450, overflowY: 'auto' }}>
          {batches === null ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>Loading…</p>
          ) : error ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--danger)' }}>Failed to load batches.</p>
          ) : batches.length === 0 ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
              {t('alerts.empty_no_batches', 'No batches received yet — receive a delivered bill to create one.')}
            </p>
          ) : (
            <div className="table-container">
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Expiry</th>
                    <th>Received</th>
                    <th>Remaining</th>
                    <th>Status</th>
                    <th>Received At</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const color = `var(--${batchStatusPillClass(b)})`;
                    return (
                      <tr key={b.id}>
                        <td style={{ color: b.is_expired ? 'var(--danger)' : 'var(--text)', fontWeight: b.is_expired ? 'bold' : 'normal' }}>{b.expiry_date}</td>
                        <td>{b.quantity_received}</td>
                        <td>
                          {b.quantity_remaining} <span style={{ fontSize: 11, color: 'var(--muted)' }}>{b.unit || ''}</span>
                        </td>
                        <td>
                          <span className="pill" style={{ color, border: `1px solid ${color}`, background: 'transparent' }}>
                            {statusLabel(b)}
                          </span>
                        </td>
                        <td style={{ color: 'var(--muted)', fontSize: 11 }}>{window.formatCairoDateTime(b.received_at, false)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn ghost"
                            style={{ padding: '4px 8px', fontSize: 11 }}
                            onClick={() => printBatchLabel(b.barcode, b.item_name, b.expiry_date)}
                          >
                            🖨️ Print
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
