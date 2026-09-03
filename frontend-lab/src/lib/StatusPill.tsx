// React port of script_lab.js's resultStatusPill (script_lab.js:4012-4023). Takes the
// caller's own `t` (from useTranslations()) rather than calling the hook itself, since a
// results table can render dozens of these per page and each hook instance would otherwise
// subscribe its own #language-selector listener for no benefit.
type TFunc = (path: string, fallback: string) => string;

const STATUS_MAP: Record<string, [pillClass: string, key: string, fallback: string]> = {
  high: ['danger', 'status_high', 'High'],
  low: ['warn', 'status_low', 'Low'],
  normal: ['ok', 'status_normal', 'Normal'],
  abnormal: ['danger', 'status_abnormal', 'Abnormal'],
  entered: ['info', 'status_entered', 'Entered'],
  pending: ['ghost', 'status_pending_pill', 'Pending'],
};

export function StatusPill({ status, t }: { status?: string | null; t: TFunc }) {
  const [pillClass, key, fallback] = STATUS_MAP[status || ''] ?? ['ghost', '', status || 'Pending'];
  const text = key ? t(`alerts.${key}`, fallback) : fallback;
  return <span className={`pill ${pillClass}`}>{text}</span>;
}
