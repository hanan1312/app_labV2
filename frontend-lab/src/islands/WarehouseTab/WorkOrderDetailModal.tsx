import { useTranslations } from '../../lib/i18n';
import { openPrintWindow } from './printWindow';
import { workOrderStatusLabel, workOrderStatusPillClass, type WorkOrderLine } from './workOrderTypes';

interface Props {
  workOrderId: string;
  lines: WorkOrderLine[];
  onClose: () => void;
}

export default function WorkOrderDetailModal({ workOrderId, lines, onClose }: Props) {
  const { t } = useTranslations();
  if (lines.length === 0) return null;

  function print() {
    const rows = lines.map((l) => `<tr><td>${l.item_name} (${l.category})</td><td>${l.quantity} ${l.unit}</td></tr>`).join('');
    openPrintWindow(
      `Work Order ${workOrderId}`,
      `<h2 style="text-align: center;">Warehouse Work Order</h2>
       <p><strong>Work Order ID:</strong> ${workOrderId}</p>
       <p><strong>Date:</strong> ${window.formatCairoDateTime(lines[0].date_time, false)}</p>
       <p><strong>Issued By:</strong> ${lines[0].user}</p>
       <table><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>`,
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
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>📦 Work Order {workOrderId}</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
          {window.formatCairoDateTime(lines[0].date_time, false)} — Issued by {lines[0].user}
        </p>

        <div className="table-container">
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Quantity</th>
                <th>Fulfilled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const color = `var(--${workOrderStatusPillClass(l.status)})`;
                return (
                  <tr key={l.id}>
                    <td>
                      {l.item_name}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{l.category}</div>
                    </td>
                    <td>
                      {l.quantity} <span style={{ color: 'var(--muted)', fontSize: 11 }}>{l.unit}</span>
                    </td>
                    <td>
                      {l.quantity_fulfilled || 0} / {l.quantity}
                    </td>
                    <td>
                      <span className="pill" style={{ color, border: `1px solid ${color}`, background: 'transparent' }}>
                        {workOrderStatusLabel(l.status, t)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={print}>
            🖨️ Print Work Order
          </button>
        </div>
      </div>
    </div>
  );
}
