import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { openPrintWindow } from './printWindow';
import type { WarehouseItemRow } from './ItemModal';

interface Props {
  item: WarehouseItemRow;
  username: string;
  onClose: () => void;
  onSaved: () => void;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function NewBillModal({ item, username, onClose, onSaved }: Props) {
  const { t } = useTranslations();
  const [orderId, setOrderId] = useState('');
  const [dateTime, setDateTime] = useState('');
  const [orderedQty, setOrderedQty] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const now = new Date();
    setOrderId(`ORD-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}`);
    setDateTime(now.toLocaleString());
    setOrderedQty('');
    setPrice('');
  }, [item]);

  const total = ((parseFloat(orderedQty) || 0) * (parseFloat(price) || 0)).toFixed(2);

  function receiptHtml() {
    return `
      <h2 style="text-align: center;">Warehouse Order Bill</h2>
      <p><strong>Order ID:</strong> ${orderId}</p>
      <p><strong>Date:</strong> ${dateTime}</p>
      <p><strong>Ordered By:</strong> ${username}</p>
      <table>
          <tr><th>Item</th><td>${item.name} (${item.category})</td></tr>
          <tr><th>Present Stock</th><td>${item.quantity} ${item.unit}</td></tr>
          <tr><th>Ordered Qty</th><td>${orderedQty} ${item.unit}</td></tr>
          <tr><th>Price Per Unit</th><td>${price} EGP</td></tr>
          <tr><th>Total Price</th><td><strong>${total} EGP</strong></td></tr>
      </table>`;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/warehouse/bills', {
        method: 'POST',
        body: JSON.stringify({
          order_id: orderId,
          item_id: item.id,
          item_name: item.name,
          present_stock: item.quantity,
          ordered_stock: parseInt(orderedQty, 10) || 0,
          unit: item.unit,
          price_per_unit: parseFloat(price) || 0,
          total_price: parseFloat(total),
          category: item.category,
          user: username,
          date_time: dateTime,
        }),
      });
      if (res.ok) {
        window.showAlert(t('alerts.bill_saved', 'Bill saved successfully!'), 'success');
        onSaved();
      }
    } catch {
      window.showAlert(t('alerts.bill_save_error', 'Error saving bill'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 600 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 20, color: 'var(--text)' }}>Create New Order Bill</h2>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, marginBottom: 15 }}>
            <div>
              <label className="form-label">Order ID</label>
              <input type="text" readOnly style={{ width: '100%', opacity: 0.7 }} value={orderId} />
            </div>
            <div>
              <label className="form-label">Date & Time</label>
              <input type="text" readOnly style={{ width: '100%', opacity: 0.7 }} value={dateTime} />
            </div>
            <div>
              <label className="form-label">Ordered By (User)</label>
              <input type="text" readOnly style={{ width: '100%', opacity: 0.7 }} value={username} />
            </div>
            <div>
              <label className="form-label">Category</label>
              <input type="text" readOnly style={{ width: '100%', opacity: 0.7 }} value={item.category} />
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 15, borderRadius: 8, marginBottom: 15 }}>
            <h3 style={{ marginBottom: 10, color: 'var(--teal)' }}>{item.name}</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                Present Stock: <strong>{item.quantity}</strong> {item.unit}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 25 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Ordered Qty</label>
              <input type="number" required min={1} style={{ width: '100%' }} value={orderedQty} onChange={(e) => setOrderedQty(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label">Price Per Unit (EGP)</label>
              <input type="number" step="0.01" required style={{ width: '100%' }} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label">Total Price (EGP)</label>
              <input type="text" readOnly style={{ width: '100%', background: 'rgba(92,189,185,0.1)', color: 'var(--ok)', fontWeight: 'bold' }} value={total} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button type="button" className="btn ghost" onClick={() => openPrintWindow('Order Receipt', receiptHtml())}>
              🖨️ Print Receipt
            </button>
            <div>
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn" style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }} disabled={saving}>
                💾 Save Bill
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
