import { useTranslations } from '../../lib/i18n';
import { billStatusPillClass } from './billTypes';

// Everyone with warehouse access can move a bill between Requested/Delivered — marking stock
// as physically delivered is a routine receiving-desk action. "Confirmed" (ordered) stays
// admin-only (server-enforced in update_bill_status()) — shown here as a disabled option
// rather than hidden, so it's visible as a status this bill can reach without looking like a
// broken/missing choice.
export default function BillStatusSelect({
  status,
  isAdmin,
  onChange,
}: {
  status: string;
  isAdmin: boolean;
  onChange: (newStatus: string) => void;
}) {
  const { t } = useTranslations();
  const color = `var(--${billStatusPillClass(status)})`;
  return (
    <select
      value={status}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      style={{ padding: 4, fontSize: 11, background: 'transparent', border: `1px solid ${color}`, color, borderRadius: 4 }}
    >
      <option value="demanded">{t('alerts.status_bill_requested', '🔴 Requested')}</option>
      <option value="ordered" disabled={!isAdmin}>
        {t('alerts.status_bill_confirmed', '🟡 Confirmed')}
        {isAdmin ? '' : t('alerts.admin_only_suffix', ' (admin only)')}
      </option>
      <option value="delivered">{t('alerts.status_bill_delivered', '🟢 Delivered')}</option>
    </select>
  );
}
