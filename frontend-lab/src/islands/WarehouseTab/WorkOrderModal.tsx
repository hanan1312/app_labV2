import { useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { WarehouseItemRow } from './ItemModal';

interface Props {
  items: WarehouseItemRow[];
  username: string;
  onClose: () => void;
  onSubmitted: () => void;
}

export default function WorkOrderModal({ items, username, onClose, onSubmitted }: Props) {
  const { t } = useTranslations();
  const [quantities, setQuantities] = useState<Record<number, string>>(() => Object.fromEntries(items.map((i) => [i.id, '1'])));
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    // No max cap here: a request no longer deducts stock at creation — it's just a request
    // that an admin must approve before any of it can actually be fulfilled (one unit at a
    // time, via barcode scan), so exceeding current stock is legitimate.
    const payload = items.map((i) => ({ item_id: i.id, quantity: parseInt(quantities[i.id] || '0', 10) || 0 })).filter((e) => e.quantity > 0);
    if (payload.length === 0) {
      window.showAlert(t('alerts.enter_quantity_for_item', 'Enter a quantity for at least one item.'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/warehouse/work-orders', {
        method: 'POST',
        body: JSON.stringify({ items: payload, user: username, date_time: new Date().toLocaleString() }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        window.showAlert(
          t('alerts.work_order_requested', 'Work order requested with {count} item(s) — awaiting admin approval.', { count: body.items_count }),
          'success'
        );
        onSubmitted();
      } else {
        window.showAlert(body.error || t('alerts.work_order_create_failed', 'Failed to create work order'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.work_order_create_error', 'Error creating work order'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 800 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>📦 Create Work Order</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>Choose how many of each selected item to take out of warehouse stock.</p>

        {items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No items selected. Check some items in the warehouse table first.</div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Current Stock</th>
                  <th>Quantity to Request</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.name}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{item.category}</div>
                    </td>
                    <td>
                      {item.quantity} <span style={{ color: 'var(--muted)', fontSize: 11 }}>{item.unit}</span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        style={{ width: 90 }}
                        value={quantities[item.id] ?? '1'}
                        onChange={(e) => setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={handleSubmit} disabled={submitting}>
            ✅ Submit
          </button>
        </div>
      </div>
    </div>
  );
}
