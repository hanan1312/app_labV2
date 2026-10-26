import { useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import type { ReferralRow } from './DayCloseTab';

interface Props {
  referral: ReferralRow;
  onClose: () => void;
  onSaved: () => void;
}

// Optional follow-up edit of an already-logged referral — the visit/test it's for stay fixed
// (delete and re-log for that), only the details typed in at logging time can change.
export default function EditReferralModal({ referral, onClose, onSaved }: Props) {
  const { t } = useTranslations();
  const feeLocked = referral.fee_payment_status === 'paid';

  const [externalLabName, setExternalLabName] = useState(referral.external_lab_name);
  const [sentDate, setSentDate] = useState(referral.sent_date || '');
  const [referenceNo, setReferenceNo] = useState(referral.reference_no || '');
  const [fee, setFee] = useState(referral.fee != null ? String(referral.fee) : '');
  const [notes, setNotes] = useState(referral.notes || '');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!externalLabName.trim()) {
      window.showAlert(t('day_close.referral_missing_lab', 'Name the external lab.'), 'warn');
      return;
    }
    let feeValue: number | null = null;
    if (fee.trim()) {
      feeValue = parseFloat(fee);
      if (!Number.isFinite(feeValue) || feeValue < 0) {
        window.showAlert(t('alerts.enter_valid_amount', 'Enter a valid amount.'), 'warn');
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/lab-referrals/${referral.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          external_lab_name: externalLabName.trim(),
          sent_date: sentDate || null,
          reference_no: referenceNo.trim() || null,
          notes: notes.trim() || null,
          ...(feeLocked ? {} : { fee: feeValue }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server rejected the update');
      }
      window.showAlert(t('day_close.referral_updated', 'Referral updated.'), 'success');
      onSaved();
    } catch (err) {
      window.showAlert(t('day_close.referral_update_error', 'Error updating referral: {msg}', { msg: (err as Error).message }), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle = { fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 5 } as const;

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 480 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 15, color: 'var(--text)' }}>{t('day_close.edit_referral', 'Edit Referral')}</h2>

        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8, marginBottom: 14 }}>
          <p><strong>{t('table_headers.patient', 'Patient')}:</strong> {referral.patient_name}</p>
          <p><strong>{t('table_headers.test', 'Test')}:</strong> {referral.test_name}</p>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{t('day_close.external_lab', 'External Lab')}</label>
            <input type="text" style={{ width: '100%' }} value={externalLabName} onChange={(e) => setExternalLabName(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{t('day_close.sent_date', 'Sent')}</label>
            <input type="date" style={{ width: '100%' }} value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
          </div>
        </div>

        <label style={labelStyle}>{t('day_close.reference_no', 'Reference No.')}</label>
        <input type="text" style={{ width: '100%', marginBottom: 14 }} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />

        <label style={labelStyle}>{t('day_close.fee', 'Fee owed to external lab (EGP)')}</label>
        <input
          type="number"
          step="0.01"
          min="0"
          style={{ width: '100%', marginBottom: feeLocked ? 4 : 14 }}
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          disabled={feeLocked}
        />
        {feeLocked && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14 }}>
            {t('day_close.fee_locked', 'Fee already paid — it can no longer be changed.')}
          </div>
        )}

        <label style={labelStyle}>{t('payments.notes', 'Notes')}</label>
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
