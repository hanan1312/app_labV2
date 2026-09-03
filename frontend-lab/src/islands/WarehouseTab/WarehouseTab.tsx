import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { useCurrentUser } from '../../lib/useCurrentUser';
import ItemModal, { type WarehouseItemRow } from './ItemModal';
import NewBillModal from './NewBillModal';
import BulkBillModal from './BulkBillModal';
import BillsHistoryModal from './BillsHistoryModal';
import BulkBillDetailModal from './BulkBillDetailModal';
import ItemBatchesModal from './ItemBatchesModal';
import ReceiveBatchModal from './ReceiveBatchModal';
import ExpiredBatchesModal from './ExpiredBatchesModal';
import WorkOrderModal from './WorkOrderModal';
import WorkOrdersHistoryModal from './WorkOrdersHistoryModal';
import type { WarehouseBillRow } from './billTypes';

const CATEGORY_COLORS = ['var(--danger)', 'var(--teal)', 'var(--warn)', 'var(--ok)', 'var(--gold)', 'var(--brand)'];

export default function WarehouseTab() {
  const { t } = useTranslations();
  const { user, isAdmin } = useCurrentUser();

  const [items, setItems] = useState<WarehouseItemRow[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [filters, setFilters] = useState({ search: '', category: '', expiredOnly: false });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WarehouseItemRow | null>(null);
  const [newBillItem, setNewBillItem] = useState<WarehouseItemRow | null>(null);
  const [bulkBillOpen, setBulkBillOpen] = useState(false);
  const [billsHistoryOpen, setBillsHistoryOpen] = useState(false);
  const [bills, setBills] = useState<WarehouseBillRow[]>([]);
  const [bulkBillDetailId, setBulkBillDetailId] = useState<string | null>(null);
  const [viewingBatchesItem, setViewingBatchesItem] = useState<WarehouseItemRow | null>(null);
  const [receivingBill, setReceivingBill] = useState<WarehouseBillRow | null>(null);
  const [expiredBatchesOpen, setExpiredBatchesOpen] = useState(false);
  const [workOrderModalOpen, setWorkOrderModalOpen] = useState(false);
  const [workOrdersHistoryOpen, setWorkOrdersHistoryOpen] = useState(false);
  const billsHistoryOpenRef = useRef(false);
  useEffect(() => {
    billsHistoryOpenRef.current = billsHistoryOpen;
  }, [billsHistoryOpen]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/warehouse')
      .then((res) => (res.ok ? (res.json() as Promise<WarehouseItemRow[]>) : null))
      .then((json) => {
        if (!cancelled && json) setItems(json);
      })
      .catch((err) => console.error('Failed to load warehouse data:', err));
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-warehouse CustomEvent bridge as every
  // other migrated tab — the latter also covers the still-vanilla Excel import, whose
  // fetchWarehouseData() call dispatches it after refreshing the `warehouseItems` global.
  // Doesn't clear filters on tab entry — matches the vanilla fetchWarehouseData(), which never
  // touched the search/category filter inputs either.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="warehouse"]');
    const onTabClick = () => setRefreshTick((n) => n + 1);
    const onExternalRefresh = () => {
      setRefreshTick((n) => n + 1);
      // Bills History is modal-open state, not part of the refreshTick-driven item fetch —
      // re-fetch it too if it's currently open.
      if (billsHistoryOpenRef.current) {
        apiFetch('/api/warehouse/bills')
          .then((res) => (res.ok ? (res.json() as Promise<WarehouseBillRow[]>) : null))
          .then((json) => json && setBills(json))
          .catch((err) => console.error('Failed to refresh bills history:', err));
      }
    };
    tabButton?.addEventListener('click', onTabClick);
    window.addEventListener('lab:refresh-warehouse', onExternalRefresh);
    return () => {
      tabButton?.removeEventListener('click', onTabClick);
      window.removeEventListener('lab:refresh-warehouse', onExternalRefresh);
    };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [filters]);

  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(), [items]);

  function categoryColor(category: string) {
    const idx = categories.indexOf(category);
    return CATEGORY_COLORS[idx >= 0 ? idx % CATEGORY_COLORS.length : 0];
  }

  const filteredItems = useMemo(() => {
    let rows = items;
    if (filters.category) rows = rows.filter((i) => i.category === filters.category);
    if (filters.search) rows = rows.filter((i) => i.name.toLowerCase().includes(filters.search.toLowerCase()));
    if (filters.expiredOnly) rows = rows.filter((i) => i.has_expired_batch);
    return rows;
  }, [items, filters]);

  function refresh() {
    setRefreshTick((n) => n + 1);
  }

  function handleImportChange(e: ChangeEvent<HTMLInputElement>) {
    window.processWarehouseExcelImport(e.nativeEvent);
    e.target.value = '';
  }

  function toggleRow(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(filteredItems.map((i) => i.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_warehouse_items', 'Delete {count} item(s) from warehouse?', { count: ids.length }))) return;
    setDeleting(true);
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/warehouse/${id}`, { method: 'DELETE' });
        if (res.ok) {
          succeeded++;
        } else {
          const body = await res.json().catch(() => ({}));
          failures.push(`#${id}: ${body.error || res.status}`);
        }
      } catch (err) {
        failures.push(`#${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      window.showAlert(t('alerts.items_deleted', 'Items deleted successfully!'), 'success');
    } else if (succeeded === 0) {
      window.showAlert(t('alerts.items_delete_error', 'Error deleting items: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(t('alerts.items_delete_partial', 'Deleted {ok} item(s); {failed} failed: {msg}', { ok: succeeded, failed: failures.length, msg: failures.join('; ') }), 'warn');
    }
    setSelected(new Set());
    setDeleting(false);
    refresh();
  }

  async function loadBillsHistory() {
    setBillsHistoryOpen(true);
    try {
      const res = await apiFetch('/api/warehouse/bills');
      if (res.ok) setBills(await res.json());
    } catch {
      window.showAlert(t('alerts.bills_load_failed', 'Failed to load bills'), 'error');
    }
  }

  async function updateBillStatus(billId: number, newStatus: string) {
    try {
      const res = await apiFetch(`/api/warehouse/bills/${billId}/status`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      if (res.ok) {
        window.showAlert(t('alerts.bill_status_updated', 'Bill status updated!'), 'success');
        await loadBillsHistory();
      } else {
        const body = await res.json().catch(() => ({}));
        window.showAlert(body.error || t('alerts.bill_status_error_generic', 'Error updating status'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.bill_status_error_generic', 'Error updating status'), 'error');
    }
  }

  async function updateGroupStatus(bulkBillId: string, newStatus: string) {
    try {
      const res = await apiFetch(`/api/warehouse/bulk-bills/${bulkBillId}/status`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      if (res.ok) {
        window.showAlert(t('alerts.bill_status_updated', 'Bill status updated!'), 'success');
        await loadBillsHistory();
      } else {
        const body = await res.json().catch(() => ({}));
        window.showAlert(body.error || t('alerts.bill_status_error', 'Error updating bill status'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.bill_status_error', 'Error updating bill status'), 'error');
    }
  }

  function handleReceive(billId: number) {
    const bill = bills.find((b) => b.id === billId);
    if (bill) setReceivingBill(bill);
  }

  // ReceiveBatchModal calls this the moment its POST succeeds (stock already changed
  // server-side at that point), not only when the modal is closed — refreshes both the item
  // list and whichever bill list is currently backing Bills History / the bulk-bill detail
  // view, so "Receive" flips to "Received" without waiting for the user to hit "Done".
  async function refreshAfterReceive() {
    refresh();
    try {
      const res = await apiFetch('/api/warehouse/bills');
      if (res.ok) setBills(await res.json());
    } catch (err) {
      console.error('Failed to refresh bills after receive:', err);
    }
  }

  const allChecked = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id));
  const bulkBillDetailBills = bulkBillDetailId ? bills.filter((b) => b.work_order_id === bulkBillDetailId) : [];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 15, marginBottom: 24 }}>
        <div>
          <h1>{t('warehouse.title', 'Warehouse Management')}</h1>
          <p style={{ color: 'var(--muted)', marginTop: 5 }}>{t('warehouse.subtitle', 'Manage lab supplies, chemicals, and instruments')}</p>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn ghost" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} onClick={loadBillsHistory}>
            🧾 Bills History
          </button>
          <button className="btn ghost" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }} onClick={() => setWorkOrdersHistoryOpen(true)}>
            📋 Work Orders
          </button>
          <button className="btn ghost" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => setBulkBillOpen(true)}>
            🧾 New Bill
          </button>
          {selected.size > 0 && (
            <button className="btn ghost" style={{ borderColor: 'var(--teal)', color: 'var(--teal)' }} onClick={() => setWorkOrderModalOpen(true)}>
              📦 New Work Order
            </button>
          )}
          <button
            className="btn ghost"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)', background: filters.expiredOnly ? 'var(--danger)' : 'transparent' }}
            onClick={() => setFilters((f) => ({ ...f, expiredOnly: !f.expiredOnly }))}
          >
            🚩 Expired Only
          </button>
          {isAdmin && (
            <button className="btn ghost" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => setExpiredBatchesOpen(true)}>
              🚩 Review Expired
            </button>
          )}
          {selected.size > 0 && (
            <button className="btn btn-danger" onClick={handleBulkDelete} disabled={deleting}>
              Delete Selected
            </button>
          )}

          <input type="file" id="import-warehouse-excel-react" accept=".xlsx, .xls, .csv" style={{ display: 'none' }} onChange={handleImportChange} />
          <button className="btn ghost" style={{ borderColor: '#3b82f6', color: '#3b82f6' }} onClick={() => document.getElementById('import-warehouse-excel-react')?.click()}>
            📤 Import Excel
          </button>
          <button
            className="btn ghost"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            onClick={(e) => window.exportTableToExcel(e.currentTarget, 'warehouse_inventory', '#warehouse-list-container-react .table-container')}
          >
            📥 Export Excel
          </button>
          <button
            className="btn"
            style={{ background: 'var(--teal)', color: '#04121d', fontWeight: 'bold' }}
            onClick={() => {
              setEditingItem(null);
              setItemModalOpen(true);
            }}
          >
            + Add New Item
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 20, display: 'flex', gap: 15, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 250 }}>
          <span className="search-icon">⌕</span>
          <input type="text" placeholder="Search item name..." value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
        </div>
        <div style={{ width: 200 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, display: 'block' }}>Category</label>
          <select
            style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: 'white' }}
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div id="warehouse-list-container-react">
        {filteredItems.length === 0 ? (
          <div className="table-container">
            <table style={{ width: '100%' }}>
              <tbody>
                <tr>
                  <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>{t('alerts.empty_no_warehouse_items', 'No items found in warehouse.')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
                  </th>
                  <th>#</th>
                  <th>Item Name</th>
                  <th>Category</th>
                  <th>Stock Level</th>
                  <th>Last Updated</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, index) => {
                  const catColor = categoryColor(item.category || '');
                  const isCritical = item.quantity <= item.critical_level;
                  return (
                    <tr key={item.id}>
                      <td>
                        <input type="checkbox" checked={selected.has(item.id)} onChange={(e) => toggleRow(item.id, e.target.checked)} />
                      </td>
                      <td>{index + 1}</td>
                      <td>
                        <strong>{item.name}</strong>
                        {item.has_expired_batch && (
                          <span
                            className="pill"
                            style={{ color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', marginLeft: 6 }}
                            title="One or more batches of this item have expired"
                          >
                            🚩 Expired batch
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="pill" style={{ color: catColor, border: `1px solid ${catColor}`, background: 'transparent' }}>
                          {item.category}
                        </span>
                      </td>
                      <td style={{ color: isCritical ? 'var(--danger)' : 'var(--text)', fontWeight: 'bold' }}>
                        {item.quantity} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 'normal' }}>{item.unit}</span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{window.formatCairoDateTime(item.updated_at, false)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {isCritical && (
                          <button
                            className="btn ghost"
                            style={{ borderColor: 'var(--danger)', color: 'var(--danger)', padding: '4px 8px', fontSize: 11, marginRight: 5 }}
                            onClick={() => setNewBillItem(item)}
                          >
                            🚨 Order Stock
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ padding: '4px 8px', fontSize: 11, marginRight: 5 }}
                          onClick={() => setViewingBatchesItem(item)}
                        >
                          🏷 Batches
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ padding: '4px 10px', fontSize: 12 }}
                          onClick={() => {
                            setEditingItem(item);
                            setItemModalOpen(true);
                          }}
                        >
                          Edit
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

      {itemModalOpen && (
        <ItemModal
          editingItem={editingItem}
          categories={categories}
          onClose={() => setItemModalOpen(false)}
          onSaved={() => {
            setItemModalOpen(false);
            refresh();
          }}
        />
      )}

      {newBillItem && <NewBillModal item={newBillItem} username={user?.username || 'Unknown User'} onClose={() => setNewBillItem(null)} onSaved={() => setNewBillItem(null)} />}

      {bulkBillOpen && (
        <BulkBillModal
          items={items}
          username={user?.username || 'Unknown User'}
          onClose={() => setBulkBillOpen(false)}
          onSaved={() => {
            setBulkBillOpen(false);
            refresh();
          }}
        />
      )}

      {billsHistoryOpen && (
        <BillsHistoryModal
          bills={bills}
          isAdmin={isAdmin}
          onClose={() => setBillsHistoryOpen(false)}
          onUpdateBillStatus={updateBillStatus}
          onUpdateGroupStatus={updateGroupStatus}
          onOpenGroupDetail={setBulkBillDetailId}
          onReceive={handleReceive}
        />
      )}

      {bulkBillDetailId && (
        <BulkBillDetailModal
          bulkBillId={bulkBillDetailId}
          bills={bulkBillDetailBills}
          isAdmin={isAdmin}
          onClose={() => setBulkBillDetailId(null)}
          onStatusChanged={loadBillsHistory}
          onReceive={handleReceive}
        />
      )}

      {viewingBatchesItem && (
        <ItemBatchesModal itemId={viewingBatchesItem.id} itemName={viewingBatchesItem.name} onClose={() => setViewingBatchesItem(null)} />
      )}

      {receivingBill && <ReceiveBatchModal bill={receivingBill} onClose={() => setReceivingBill(null)} onReceived={refreshAfterReceive} />}

      {expiredBatchesOpen && <ExpiredBatchesModal onClose={() => setExpiredBatchesOpen(false)} onDisposed={refresh} />}

      {workOrderModalOpen && (
        <WorkOrderModal
          items={items.filter((i) => selected.has(i.id))}
          username={user?.username || 'Unknown User'}
          onClose={() => setWorkOrderModalOpen(false)}
          onSubmitted={() => {
            setWorkOrderModalOpen(false);
            setSelected(new Set());
          }}
        />
      )}

      {workOrdersHistoryOpen && <WorkOrdersHistoryModal isAdmin={isAdmin} onClose={() => setWorkOrdersHistoryOpen(false)} onStockChanged={refresh} />}
    </>
  );
}
