import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { workOrderGroupStatus, workOrderStatusLabel, workOrderStatusPillClass, type WorkOrderLine } from './workOrderTypes';
import WorkOrderDetailModal from './WorkOrderDetailModal';
import FulfillScanModal from './FulfillScanModal';

interface Props {
  isAdmin: boolean;
  onClose: () => void;
  // Bubbles up to WarehouseTab's refresh() — a successful scan changes item stock numbers
  // that only WarehouseTab's own item list holds.
  onStockChanged: () => void;
}

export default function WorkOrdersHistoryModal({ isAdmin, onClose, onStockChanged }: Props) {
  const { t } = useTranslations();
  const [workOrders, setWorkOrders] = useState<WorkOrderLine[] | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch('/api/warehouse/work-orders');
      if (res.ok) setWorkOrders(await res.json());
    } catch {
      window.showAlert(t('alerts.work_orders_load_failed', 'Failed to load work orders'), 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const grouped = new Map<string, WorkOrderLine[]>();
  (workOrders || []).forEach((r) => {
    const list = grouped.get(r.work_order_id) || [];
    list.push(r);
    grouped.set(r.work_order_id, list);
  });

  async function approve(workOrderId: string) {
    if (
      !window.confirm(
        t(
          'alerts.confirm_approve_work_order',
          'Approve work order {id}? The technician will then be able to fulfill it by scanning batch barcodes.',
          { id: workOrderId }
        )
      )
    )
      return;
    try {
      const res = await apiFetch(`/api/warehouse/work-orders/${workOrderId}/approve`, { method: 'PUT' });
      const body = await res.json();
      if (res.ok && body.success) {
        window.showAlert(t('alerts.work_order_approved', 'Work order approved.'), 'success');
        load();
      } else {
        window.showAlert(body.error || t('alerts.work_order_approve_failed', 'Failed to approve work order'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.work_order_approve_error', 'Error approving work order'), 'error');
    }
  }

  async function reject(workOrderId: string) {
    if (!window.confirm(t('alerts.confirm_reject_work_order', 'Reject work order {id}? This cannot be undone.', { id: workOrderId }))) return;
    try {
      const res = await apiFetch(`/api/warehouse/work-orders/${workOrderId}/reject`, { method: 'PUT' });
      const body = await res.json();
      if (res.ok && body.success) {
        window.showAlert(t('alerts.work_order_rejected', 'Work order rejected.'), 'success');
        load();
      } else {
        window.showAlert(body.error || t('alerts.work_order_reject_failed', 'Failed to reject work order'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.work_order_reject_error', 'Error rejecting work order'), 'error');
    }
  }

  const detailLines = detailId ? grouped.get(detailId) || [] : [];
  const scanningLines = scanningId ? grouped.get(scanningId) || [] : [];

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 900 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, color: 'var(--text)' }}>Warehouse Work Orders</h2>
          <button
            className="btn ghost"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)', fontSize: 12, padding: '4px 10px' }}
            onClick={(e) => window.exportTableToExcel(e.currentTarget, 'warehouse_work_orders', '#work-orders-history-container .table-container')}
          >
            📥 Export to Excel
          </button>
        </div>

        <div id="work-orders-history-container" style={{ maxHeight: 400, overflowY: 'auto' }}>
          {workOrders === null ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>Loading…</p>
          ) : grouped.size === 0 ? (
            <p style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>{t('alerts.empty_no_work_orders', 'No work orders yet.')}</p>
          ) : (
            <div className="table-container">
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>ID</th>
                    <th>Item/s</th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {[...grouped.entries()].map(([workOrderId, lines]) => {
                    const status = workOrderGroupStatus(lines);
                    const color = `var(--${workOrderStatusPillClass(status)})`;
                    const itemsLabel = lines.length === 1 ? lines[0].item_name : `${lines.length} items`;
                    return (
                      <tr key={workOrderId} style={{ cursor: 'pointer' }} onClick={() => setDetailId(workOrderId)} title="View work order details">
                        <td style={{ color: 'var(--muted)', fontSize: 11 }}>{window.formatCairoDateTime(lines[0].date_time, false)}</td>
                        <td>
                          <strong>{workOrderId}</strong>
                        </td>
                        <td>{itemsLabel}</td>
                        <td style={{ color: 'var(--muted)' }}>{lines[0].user}</td>
                        <td>
                          <span className="pill" style={{ color, border: `1px solid ${color}`, background: 'transparent' }}>
                            {workOrderStatusLabel(status, t)}
                          </span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {status === 'requested' && isAdmin && (
                            <>
                              <button
                                type="button"
                                className="btn ghost"
                                style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '4px 8px', fontSize: 11, marginRight: 5 }}
                                onClick={() => approve(workOrderId)}
                              >
                                ✅ Approve
                              </button>
                              <button
                                type="button"
                                className="btn ghost"
                                style={{ borderColor: 'var(--danger)', color: 'var(--danger)', padding: '4px 8px', fontSize: 11 }}
                                onClick={() => reject(workOrderId)}
                              >
                                ❌ Reject
                              </button>
                            </>
                          )}
                          {status === 'approved' && (
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ borderColor: 'var(--teal)', color: 'var(--teal)', padding: '4px 8px', fontSize: 11 }}
                              onClick={() => setScanningId(workOrderId)}
                            >
                              🔫 Fulfill via Scan
                            </button>
                          )}
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

      {detailId && <WorkOrderDetailModal workOrderId={detailId} lines={detailLines} onClose={() => setDetailId(null)} />}

      {scanningId && (
        <FulfillScanModal
          workOrderId={scanningId}
          initialLines={scanningLines}
          onClose={() => {
            setScanningId(null);
            load();
          }}
          onProgress={() => {
            load();
            onStockChanged();
          }}
        />
      )}
    </div>
  );
}
