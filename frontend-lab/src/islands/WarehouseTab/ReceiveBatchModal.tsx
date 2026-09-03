import { useMemo, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { WarehouseBillRow } from './billTypes';
import { batchBarcodeImage, printBatchLabel } from './batchLabel';

interface Props {
  bill: WarehouseBillRow;
  onClose: () => void;
  onReceived: () => void;
}

interface ReceivedBatch {
  barcode: string;
  item_name: string;
  expiry_date: string;
}

export default function ReceiveBatchModal({ bill, onClose, onReceived }: Props) {
  const { t } = useTranslations();
  const [quantity, setQuantity] = useState(String(bill.ordered_stock));
  const [expiryDate, setExpiryDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [received, setReceived] = useState<ReceivedBatch | null>(null);

  const barcodeImgSrc = useMemo(() => (received ? batchBarcodeImage(received.barcode) : null), [received]);

  async function handleSubmit() {
    if (!expiryDate) {
      window.showAlert(t('alerts.expiry_date_required', 'Expiry date is required.'), 'error');
      return;
    }
    const qty = parseInt(quantity, 10) || 0;
    if (qty <= 0) {
      window.showAlert(t('alerts.quantity_must_be_positive', 'Quantity received must be greater than zero.'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/warehouse/bills/${bill.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ expiry_date: expiryDate, quantity_received: qty }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setReceived({ barcode: body.barcode, item_name: body.item_name, expiry_date: body.expiry_date });
        onReceived();
      } else {
        window.showAlert(body.error || t('alerts.batch_receive_failed', 'Failed to receive batch'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.batch_receive_error', 'Error receiving batch'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 480 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>📥 Receive into Warehouse</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>
          {bill.item_name} — {bill.ordered_stock} {bill.unit || ''} ordered
        </p>

        {!received ? (
          <div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Quantity Received</label>
              <input type="number" min={1} style={{ width: '100%', marginTop: 5 }} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Expiry Date</label>
              <input type="date" required style={{ width: '100%', marginTop: 5 }} value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--teal)', color: '#04121d', fontWeight: 'bold' }}
                onClick={handleSubmit}
                disabled={submitting}
              >
                ✅ Receive &amp; Generate Barcode
              </button>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--ok)', fontWeight: 'bold' }}>✅ Batch received into warehouse!</p>
            <div style={{ background: 'white', padding: 12, borderRadius: 6, margin: '15px 0', display: 'inline-block' }}>
              <img src={barcodeImgSrc ?? undefined} style={{ display: 'block' }} alt={received.barcode} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 10 }}>
              <button type="button" className="btn ghost" onClick={() => printBatchLabel(received.barcode, received.item_name, received.expiry_date)}>
                🖨️ Print Label
              </button>
              <button type="button" className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
