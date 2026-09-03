export interface WorkOrderLine {
  id: number;
  work_order_id: string;
  item_id: number;
  item_name: string;
  quantity: number;
  unit: string;
  category: string;
  user: string;
  date_time: string;
  status: 'requested' | 'approved' | 'completed' | 'rejected';
  quantity_fulfilled: number;
  approved_by: string | null;
  approved_at: string;
}

// A work order's overall status is a derived aggregate over its per-item lines — same
// approach as billTypes.ts's groupStatus() for bulk bills, since there's no separate
// header/status row of its own.
export function workOrderGroupStatus(lines: WorkOrderLine[]): string {
  if (lines.some((l) => l.status === 'requested')) return 'requested';
  if (lines.every((l) => l.status === 'rejected')) return 'rejected';
  if (lines.some((l) => l.status === 'approved')) return 'approved';
  return 'completed';
}

export function workOrderStatusPillClass(status: string): string {
  const map: Record<string, string> = { requested: 'danger', approved: 'warn', completed: 'ok', rejected: 'muted' };
  return map[status] || 'muted';
}

export function workOrderStatusLabel(status: string, t: (path: string, fallback: string) => string): string {
  switch (status) {
    case 'requested':
      return t('alerts.status_wo_requested', '🔴 Requested');
    case 'approved':
      return t('alerts.status_wo_approved', '🟡 Approved');
    case 'completed':
      return t('alerts.status_wo_completed', '🟢 Completed');
    case 'rejected':
      return t('alerts.status_wo_rejected', '⚪ Rejected');
    default:
      return status;
  }
}
