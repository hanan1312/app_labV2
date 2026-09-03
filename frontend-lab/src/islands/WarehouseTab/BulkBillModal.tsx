import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { WarehouseItemRow } from './ItemModal';

interface Row {
  itemId: number;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  checked: boolean;
  qty: string;
  price: string;
}

interface Props {
  items: WarehouseItemRow[];
  username: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function BulkBillModal({ items, username, onClose, onSaved }: Props) {
  const { t } = useTranslations();
  const [rows, setRows] = useState<Row[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const critical = items.filter((i) => i.quantity <= i.critical_level);
    setRows(
      critical.map((i) => ({
        itemId: i.id,
        name: i.name,
        category: i.category,
        quantity: i.quantity,
        unit: i.unit,
        checked: true,
        // Suggest restocking to 3x the critical level — a comfortable buffer above the
        // low-stock threshold. Fully editable, just a starting point.
        qty: String(Math.max(1, i.critical_level * 3 - i.quantity)),
        price: '',
      }))
    );
  }, [items]);

  const allChecked = rows.length > 0 && rows.every((r) => r.checked);

  function toggleAll(checked: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, checked })));
  }

  function updateRow(itemId: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.itemId === itemId ? { ...r, ...patch } : r)));
  }

  async function handleSubmit() {
    const selected = rows.filter((r) => r.checked && (parseInt(r.qty, 10) || 0) > 0);
    if (selected.length === 0) {
      window.showAlert(t('alerts.select_item_with_quantity', 'Select at least one item with a quantity to order.'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/warehouse/bulk-bills', {
        method: 'POST',
        body: JSON.stringify({
          items: selected.map((r) => ({ item_id: r.itemId, quantity: parseInt(r.qty, 10) || 0, price_per_unit: parseFloat(r.price) || 0 })),
          user: username,
          date_time: new Date().toLocaleString(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        window.showAlert(t('alerts.bill_created', 'Bill created with {count} item(s)!', { count: body.items_count }), 'success');
        onSaved();
      } else {
        window.showAlert(body.error || t('alerts.bill_create_failed', 'Failed to create bill'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.bill_create_error', 'Error creating bill'), 'error');
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
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>🧾 Create New Bill</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
          Items currently at or below their critical stock level. Uncheck any you don't want to include, and set the quantity to order for the rest.
        </p>

        {rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No items are currently low on stock.</div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
                  </th>
                  <th>Item</th>
                  <th>Current Stock</th>
                  <th>Order Qty</th>
                  <th>Price/Unit (EGP)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId}>
                    <td>
                      <input type="checkbox" checked={r.checked} onChange={(e) => updateRow(r.itemId, { checked: e.target.checked })} />
                    </td>
                    <td>
                      {r.name}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.category}</div>
                    </td>
                    <td style={{ color: 'var(--danger)' }}>
                      {r.quantity} <span style={{ color: 'var(--muted)', fontSize: 11 }}>{r.unit}</span>
                    </td>
                    <td>
                      <input type="number" min={1} style={{ width: 90 }} value={r.qty} onChange={(e) => updateRow(r.itemId, { qty: e.target.value })} />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        style={{ width: 100 }}
                        value={r.price}
                        onChange={(e) => updateRow(r.itemId, { price: e.target.value })}
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
            🚨 Order Stock
          </button>
        </div>
      </div>
    </div>
  );
}
