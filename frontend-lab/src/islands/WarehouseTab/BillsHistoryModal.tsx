import { useTranslations } from '../../lib/i18n';
import { groupStatus, type WarehouseBillRow } from './billTypes';
import BillStatusSelect from './BillStatusSelect';

interface Props {
  bills: WarehouseBillRow[];
  isAdmin: boolean;
  onClose: () => void;
  onUpdateBillStatus: (billId: number, newStatus: string) => void;
  onUpdateGroupStatus: (bulkBillId: string, newStatus: string) => void;
  onOpenGroupDetail: (bulkBillId: string) => void;
  onReceive: (billId: number) => void;
}

function ReceiveCell({ bill, onReceive }: { bill: WarehouseBillRow; onReceive: (billId: number) => void }) {
  if (bill.status !== 'delivered') return <>—</>;
  if (bill.received) return <span style={{ color: 'var(--ok)', fontSize: 11 }}>✅ Received</span>;
  return (
    <button type="button" className="btn ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => onReceive(bill.id)}>
      📥 Receive
    </button>
  );
}

export default function BillsHistoryModal({ bills, isAdmin, onClose, onUpdateBillStatus, onUpdateGroupStatus, onOpenGroupDetail, onReceive }: Props) {
  const { t } = useTranslations();

  const bulkGroups = new Map<string, WarehouseBillRow[]>();
  const standalone: WarehouseBillRow[] = [];
  bills.forEach((b) => {
    if (b.work_order_id) {
      const list = bulkGroups.get(b.work_order_id) || [];
      list.push(b);
      bulkGroups.set(b.work_order_id, list);
    } else {
      standalone.push(b);
    }
  });

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 900 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ color: 'var(--text)' }}>Warehouse Bills History</h2>
          <button
            className="btn ghost"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)', fontSize: 12, padding: '4px 10px' }}
            onClick={(e) => window.exportTableToExcel(e.currentTarget, 'warehouse_bills_history', '#bills-history-container .table-container')}
          >
            📥 Export Excel
          </button>
        </div>

        <div id="bills-history-container" style={{ maxHeight: 400, overflowY: 'auto' }}>
          {bills.length === 0 ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>{t('alerts.empty_no_bills_history', 'No bills history available.')}</p>
          ) : (
            <div className="table-container">
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Order ID</th>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Total</th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Warehouse</th>
                  </tr>
                </thead>
                <tbody>
                  {[...bulkGroups.entries()].map(([bulkBillId, groupBills]) => {
                    const status = groupStatus(groupBills);
                    const totalPrice = groupBills.reduce((sum, b) => sum + (b.total_price || 0), 0);
                    const deliveredCount = groupBills.filter((b) => b.status === 'delivered').length;
                    const receivedCount = groupBills.filter((b) => b.received).length;
                    return (
                      <tr key={bulkBillId} style={{ cursor: 'pointer' }} onClick={() => onOpenGroupDetail(bulkBillId)} title="View bill details">
                        <td style={{ color: 'var(--muted)', fontSize: 11 }}>{window.formatCairoDateTime(groupBills[0].date_time, false)}</td>
                        <td>
                          <strong>{bulkBillId}</strong>
                        </td>
                        <td>
                          🧾 New Bill — {groupBills.length} item{groupBills.length > 1 ? 's' : ''}
                        </td>
                        <td>—</td>
                        <td>{totalPrice.toFixed(2)} EGP</td>
                        <td style={{ color: 'var(--muted)' }}>{groupBills[0].user}</td>
                        <td>
                          <BillStatusSelect status={status} isAdmin={isAdmin} onChange={(s) => onUpdateGroupStatus(bulkBillId, s)} />
                        </td>
                        <td style={{ color: 'var(--muted)', fontSize: 11 }}>{deliveredCount === 0 ? '—' : `${receivedCount}/${deliveredCount} received`}</td>
                      </tr>
                    );
                  })}
                  {standalone.map((b) => (
                    <tr key={b.id}>
                      <td style={{ color: 'var(--muted)', fontSize: 11 }}>{window.formatCairoDateTime(b.date_time, false)}</td>
                      <td>
                        <strong>{b.order_id}</strong>
                      </td>
                      <td>{b.item_name}</td>
                      <td>
                        {b.ordered_stock} <span style={{ fontSize: 10, color: 'var(--muted)' }}>{b.unit}</span>
                      </td>
                      <td>{b.total_price} EGP</td>
                      <td style={{ color: 'var(--muted)' }}>{b.user}</td>
                      <td>
                        <BillStatusSelect status={b.status} isAdmin={isAdmin} onChange={(s) => onUpdateBillStatus(b.id, s)} />
                      </td>
                      <td>
                        <ReceiveCell bill={b} onReceive={onReceive} />
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
