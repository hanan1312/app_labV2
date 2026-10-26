import { useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { PaymentRow } from './PaymentsTab';

// Port of script_lab.js's cairoDateStr() — "YYYY-MM-DD" as it reads in Africa/Cairo local
// time, matching the server-stamped date strings this app keys everything else off (it uses
// now_cairo(), not UTC) regardless of the viewing browser's own OS timezone. Kept as its own
// local copy rather than a shared helper — see FinancialOverviewTab.tsx's identical copy.
function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

interface Props {
  payment?: PaymentRow;
  onClose: () => void;
  onSaved: () => void;
}

export default function PaymentModal({ payment, onClose, onSaved }: Props) {
  const { t } = useTranslations();
  const editing = !!payment;

  const [category, setCategory] = useState(payment?.category || '');
  const [description, setDescription] = useState(payment?.description || '');
  const [amount, setAmount] = useState(payment ? String(payment.amount) : '');
  const [paidTo, setPaidTo] = useState(payment?.paid_to || '');
  const [paymentMethod, setPaymentMethod] = useState(payment?.payment_method || '');
  const [paymentDate, setPaymentDate] = useState(payment?.payment_date || todayStr());
  const [notes, setNotes] = useState(payment?.notes || '');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const value = parseFloat(amount);
    if (!category.trim() || !description.trim()) {
      window.showAlert(t('payments.missing_fields', 'Category and description are required.'), 'warn');
      return;
    }
    if (!value || value <= 0) {
      window.showAlert(t('alerts.enter_valid_amount', 'Enter a valid amount.'), 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const body = JSON.stringify({
        category: category.trim(),
        description: description.trim(),
        amount: value,
        paid_to: paidTo.trim() || null,
        payment_method: paymentMethod.trim() || null,
        payment_date: paymentDate,
        notes: notes.trim() || null,
      });
      const res = await apiFetch(editing ? `/api/payments/${payment!.id}` : '/api/payments', {
        method: editing ? 'PUT' : 'POST',
        body,
      });
      if (!res.ok) throw new Error('Server rejected the payment');
      window.showAlert(t('payments.saved', 'Payment saved!'), 'success');
      onSaved();
    } catch (err) {
      window.showAlert(t('payments.save_error', 'Error saving payment: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 460 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 15, color: 'var(--text)' }}>
          {editing ? t('payments.edit_title', 'Edit Payment') : t('payments.add_title', 'Log a Payment')}
        </h2>

        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('payments.category', 'Category')}</label>
        <input list="payment-category-list" style={{ width: '100%', marginBottom: 14 }} value={category} onChange={(e) => setCategory(e.target.value)} />

        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('payments.description', 'Description')}</label>
        <input type="text" style={{ width: '100%', marginBottom: 14 }} value={description} onChange={(e) => setDescription(e.target.value)} />

        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('table_headers.amount', 'Amount')} (EGP)</label>
            <input type="number" step="0.01" style={{ width: '100%' }} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('table_headers.date', 'Date')}</label>
            <input type="date" style={{ width: '100%' }} value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('payments.paid_to', 'Paid To')}</label>
            <input type="text" style={{ width: '100%' }} value={paidTo} onChange={(e) => setPaidTo(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('history.method', 'Method')}</label>
            <input type="text" list="pay-method-list" style={{ width: '100%' }} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} />
          </div>
        </div>

        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>{t('payments.notes', 'Notes')}</label>
        <textarea style={{ width: '100%', marginBottom: 20, minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} />

        <button
          className="btn"
          style={{ width: '100%', background: 'var(--teal)', color: '#04121d', fontSize: 15, padding: 10 }}
          onClick={handleSubmit}
          disabled={submitting}
        >
          ✅ {t('actions.save', 'Save')}
        </button>
      </div>
    </div>
  );
}
