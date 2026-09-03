import { useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { TransactionRow } from './TransactionHistoryTab';

interface Props {
  transaction: TransactionRow;
  onClose: () => void;
  onPaid: () => void;
}

export default function CompletePaymentModal({ transaction, onClose, onPaid }: Props) {
  const { t } = useTranslations();
  const [amount, setAmount] = useState((transaction.remaining_fees || 0).toFixed(2));
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const value = parseFloat(amount);
    if (!value || value <= 0) {
      window.showAlert(t('alerts.enter_valid_amount', 'Enter a valid amount.'), 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/transactions/${transaction.id}/payment`, {
        method: 'PUT',
        body: JSON.stringify({ amount: value }),
      });
      if (!res.ok) throw new Error('Server rejected payment update');
      window.showAlert(t('alerts.payment_recorded', 'Payment recorded!'), 'success');
      onPaid();
    } catch (err) {
      window.showAlert(t('alerts.payment_record_error', 'Error recording payment: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 420 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 15, color: 'var(--text)' }}>Complete Payment</h2>
        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 15, borderRadius: 8, marginBottom: 20 }}>
          <p>
            <strong>Patient:</strong> {transaction.patient_name}
          </p>
          <p>
            <strong>Trans ID:</strong> <span style={{ color: 'var(--teal)' }}>{transaction.transaction_id}</span>
          </p>
          <p>
            <strong>Remaining Fees:</strong> <span style={{ color: 'var(--danger)', fontWeight: 'bold' }}>{(transaction.remaining_fees || 0).toFixed(2)}</span> EGP
          </p>
        </div>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Amount Received Now</label>
        <input type="number" step="0.01" style={{ width: '100%', marginBottom: 20 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button
          className="btn"
          style={{ width: '100%', background: 'var(--teal)', color: '#04121d', fontSize: 15, padding: 10 }}
          onClick={handleSubmit}
          disabled={submitting}
        >
          ✅ Confirm Payment
        </button>
      </div>
    </div>
  );
}
