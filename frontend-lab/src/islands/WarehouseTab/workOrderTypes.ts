import { statusInfo, statusColorCssVar, type SkinConfig } from '../../lib/skinConfig';

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

const FALLBACKS: Record<string, { label: string; colorClass: string }> = {
  requested: { label: '🔴 Requested', colorClass: 'danger' },
  approved: { label: '🟡 Approved', colorClass: 'warn' },
  completed: { label: '🟢 Completed', colorClass: 'ok' },
  rejected: { label: '⚪ Rejected', colorClass: 'muted' },
};

// skin is optional (defaults to skins.json's default lab wording via FALLBACKS) so existing
// callers that haven't been threaded a skin config yet keep working unchanged.
export function workOrderStatusPillClass(status: string, skin?: SkinConfig | null): string {
  const fallbackColorClass = FALLBACKS[status]?.colorClass || 'muted';
  return statusColorCssVar(skin ?? null, 'workOrder', status, fallbackColorClass);
}

export function workOrderStatusLabel(status: string, t: (path: string, fallback: string) => string, skin?: SkinConfig | null): string {
  const fallback = FALLBACKS[status] || { label: status, colorClass: 'muted' };
  return statusInfo(skin ?? null, 'workOrder', status, t, fallback).label;
}
