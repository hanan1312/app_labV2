import { statusInfo, statusColorCssVar, type SkinConfig } from '../../lib/skinConfig';

export interface WarehouseBillRow {
  id: number;
  order_id: string;
  item_id: number;
  item_name: string;
  present_stock: number;
  ordered_stock: number;
  unit: string;
  price_per_unit: number;
  total_price: number;
  category: string;
  user: string;
  date_time: string;
  status: 'demanded' | 'ordered' | 'delivered';
  work_order_id: string | null;
  received: boolean;
}

const FALLBACKS: Record<string, { label: string; colorClass: string }> = {
  demanded: { label: '🔴 Requested', colorClass: 'danger' },
  ordered: { label: '🟡 Confirmed', colorClass: 'warn' },
  delivered: { label: '🟢 Delivered', colorClass: 'ok' },
};

export function billStatusPillClass(status: string, skin?: SkinConfig | null): string {
  const fallbackColorClass = FALLBACKS[status]?.colorClass || 'ok';
  return statusColorCssVar(skin ?? null, 'warehouseBill', status, fallbackColorClass);
}

export function billStatusLabel(status: string, t: (path: string, fallback: string) => string, skin?: SkinConfig | null): string {
  const fallback = FALLBACKS[status] || { label: status, colorClass: 'ok' };
  return statusInfo(skin ?? null, 'warehouseBill', status, t, fallback).label;
}

// A bulk bill's overall status is whichever of its items is least far along — "Delivered"
// only once every item in it has actually been delivered.
export function groupStatus(bills: WarehouseBillRow[]): string {
  if (bills.some((b) => b.status === 'demanded')) return 'demanded';
  if (bills.some((b) => b.status === 'ordered')) return 'ordered';
  return 'delivered';
}
