import { statusInfo, statusColorCssVar, type SkinConfig } from '../../lib/skinConfig';

export interface WarehouseBatchRow {
  id: number;
  item_id: number;
  item_name: string;
  unit: string;
  category: string;
  barcode: string;
  expiry_date: string;
  quantity_received: number;
  quantity_remaining: number;
  status: 'active' | 'exhausted' | 'disposed';
  is_expired: boolean;
  received_by: string;
  received_at: string;
}

// "expired" isn't a stored status (see docs/app_flow_blueprint.md's Warehouse section) — it's
// is_expired=true overriding an otherwise-active batch — so it's resolved to skins.json's
// `statuses.warehouseBatch.expired` entry here rather than being one of the real DB values.
function effectiveStatusValue(batch: WarehouseBatchRow): string {
  if (batch.is_expired) return 'expired';
  return batch.status;
}

const FALLBACKS: Record<string, { label: string; colorClass: string }> = {
  expired: { label: '🚩 Expired', colorClass: 'danger' },
  disposed: { label: 'Disposed', colorClass: 'muted' },
  exhausted: { label: 'Exhausted', colorClass: 'muted' },
  active: { label: 'Active', colorClass: 'ok' },
};

export function batchStatusPillClass(batch: WarehouseBatchRow, skin?: SkinConfig | null): string {
  const value = effectiveStatusValue(batch);
  const fallbackColorClass = FALLBACKS[value]?.colorClass || 'ok';
  return statusColorCssVar(skin ?? null, 'warehouseBatch', value, fallbackColorClass);
}

export function batchStatusLabel(batch: WarehouseBatchRow, t: (path: string, fallback: string) => string, skin?: SkinConfig | null): string {
  const value = effectiveStatusValue(batch);
  const fallback = FALLBACKS[value] || { label: value, colorClass: 'ok' };
  return statusInfo(skin ?? null, 'warehouseBatch', value, t, fallback).label;
}
