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

export function batchStatusPillClass(batch: WarehouseBatchRow): string {
  if (batch.is_expired) return 'danger';
  if (batch.status === 'disposed') return 'muted';
  if (batch.status === 'exhausted') return 'muted';
  return 'ok';
}
