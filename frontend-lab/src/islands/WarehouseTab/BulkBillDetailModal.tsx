import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { openPrintWindow } from './printWindow';
import { groupStatus, type WarehouseBillRow } from './billTypes';
import BillStatusSelect from './BillStatusSelect';

interface Props {
  bulkBillId: string;
  bills: WarehouseBillRow[];
  isAdmin: boolean;
  onClose: () => void;
  onStatusChanged: () => void;
  onReceive: (billId: number) => void;
}

export default function BulkBillDetailModal({ bulkBillId, bills, isAdmin, onClose, onStatusChanged, onReceive }: Props) {
  const { t } = useTranslations();
  if (bills.length === 0) return null;

  const status = groupStatus(bills);
  const totalPrice = bills.reduce((sum, b) => sum + (b.total_price || 0), 0);

  async function updateStatus(newStatus: string) {
    try {
      const res = await apiFetch(`/api/warehouse/bulk-bills/${bulkBillId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        window.showAlert(t('alerts.bill_status_updated', 'Bill status updated!'), 'success');
        onStatusChanged();
      } else {
        const body = await res.json().catch(() => ({}));
        window.showAlert(body.error || t('alerts.bill_status_error', 'Error updating bill status'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.bill_status_error', 'Error updating bill status'), 'error');
    }
  }

  function print() {
    const rows = bills
      .map(
        (b) => `
        <tr>
            <td>${b.item_name} (${b.category})</td>
            <td>${b.ordered_stock} ${b.unit}</td>
            <td>${b.price_per_unit} EGP</td>
            <td>${b.total_price} EGP</td>
        </tr>`
      )
      .join('');
    openPrintWindow(
      `Bill ${bulkBillId}`,
      `
      <h2 style="text-align: center;">Warehouse Bill</h2>
      <p><strong>Bill ID:</strong> ${bulkBillId}</p>
      <p><strong>Date:</strong> ${window.formatCairoDateTime(bills[0].date_time, false)}</p>
      <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Price/Unit</th><th>Subtotal</th></tr></thead>
          <tbody>${rows}</tbody>
      </table>
      <p style="text-align:right; margin-top: 10px;"><strong>Total: ${totalPrice.toFixed(2)} EGP</strong></p>`,
      700,
      700
    );
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 700 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>🧾 New Bill {bulkBillId}</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
          {window.formatCairoDateTime(bills[0].date_time, false)} — Requested by {bills[0].user}
        </p>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>Status:</span>
          <BillStatusSelect status={status} isAdmin={isAdmin} onChange={updateStatus} />
        </div>

        <div className="table-container">
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Price/Unit</th>
                <th>Subtotal</th>
                <th>Warehouse</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.item_name}
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.category}</div>
                  </td>
                  <td>
                    {b.ordered_stock} <span style={{ color: 'var(--muted)', fontSize: 11 }}>{b.unit}</span>
                  </td>
                  <td>{b.price_per_unit} EGP</td>
                  <td>{b.total_price} EGP</td>
                  <td>
                    {b.status !== 'delivered' ? (
                      '—'
                    ) : b.received ? (
                      <span style={{ color: 'var(--ok)', fontSize: 11 }}>✅ Received</span>
                    ) : (
                      <button type="button" className="btn ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => onReceive(b.id)}>
                        📥 Receive
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ textAlign: 'right', marginTop: 10, color: 'var(--ok)', fontWeight: 'bold', fontSize: 15 }}>Total: {totalPrice.toFixed(2)} EGP</div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={print}>
            🖨️ Print Bill
          </button>
        </div>
      </div>
    </div>
  );
}
