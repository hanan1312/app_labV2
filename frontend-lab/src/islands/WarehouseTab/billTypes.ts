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

export function billStatusPillClass(status: string): string {
  return status === 'demanded' ? 'danger' : status === 'ordered' ? 'warn' : 'ok';
}

// A bulk bill's overall status is whichever of its items is least far along — "Delivered"
// only once every item in it has actually been delivered.
export function groupStatus(bills: WarehouseBillRow[]): string {
  if (bills.some((b) => b.status === 'demanded')) return 'demanded';
  if (bills.some((b) => b.status === 'ordered')) return 'ordered';
  return 'delivered';
}
