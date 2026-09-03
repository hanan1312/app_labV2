import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { workOrderStatusLabel, workOrderStatusPillClass, type WorkOrderLine } from './workOrderTypes';

interface Props {
  workOrderId: string;
  initialLines: WorkOrderLine[];
  onClose: () => void;
  // Called after every successful scan — refreshes both the work-orders list (this modal's
  // own progress table) and the underlying item stock numbers back in WarehouseTab, same two
  // refreshes submitBatchScan() used to do in one shot (refetch warehouseWorkOrders +
  // fetchWarehouseData()).
  onProgress: () => void;
}

type Feedback = { kind: 'success'; text: string } | { kind: 'fefo'; message: string; barcode: string } | { kind: 'error'; text: string };

export default function FulfillScanModal({ workOrderId, initialLines, onClose, onProgress }: Props) {
  const { t } = useTranslations();
  const [lines, setLines] = useState<WorkOrderLine[]>(initialLines);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Mirrors the vanilla input.onblur = () => setTimeout(fulfillScanFocusInput, 50) — keeps
  // the field "always focused" for a keyboard-wedge HID scanner even as buttons are clicked.
  function refocus() {
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function refreshLines() {
    try {
      const res = await apiFetch('/api/warehouse/work-orders');
      if (res.ok) {
        const all: WorkOrderLine[] = await res.json();
        setLines(all.filter((l) => l.work_order_id === workOrderId));
      }
    } catch {
      // keep whatever progress we already had rendered
    }
  }

  async function submitScan(overrideBarcode?: string, confirmOverride?: boolean) {
    const input = inputRef.current;
    const barcode = overrideBarcode ?? (input ? input.value.trim() : '');
    // Clear immediately (before the fetch resolves) so the physical scanner can fire again
    // right away, matching submitBatchScan()'s original clear-then-await order.
    if (input) input.value = '';
    if (!barcode) return;

    try {
      const res = await apiFetch(`/api/warehouse/work-orders/${workOrderId}/scan`, {
        method: 'POST',
        body: JSON.stringify({ barcode, confirm_fefo_override: !!confirmOverride }),
      });
      const body = await res.json();

      if (res.ok && body.success) {
        const suffix = body.line_complete ? t('alerts.scan_line_complete_suffix', ' — line complete!') : '';
        setFeedback({
          kind: 'success',
          text:
            t('alerts.scan_success', 'Scanned {item} — {fulfilled}/{requested} fulfilled', {
              item: body.item_name,
              fulfilled: body.line_fulfilled,
              requested: body.line_requested,
            }) + suffix,
        });
        await refreshLines();
        onProgress();
      } else if (res.status === 409 && body.fefo_warning) {
        // FEFO violation: soft warning, nothing mutated yet. body.message is a raw
        // server-generated string (not translated server-side either), shown as-is.
        setFeedback({ kind: 'fefo', message: body.message, barcode });
      } else {
        setFeedback({ kind: 'error', text: body.error || t('alerts.scan_failed_generic', 'Scan failed') });
      }
    } catch {
      setFeedback({ kind: 'error', text: t('alerts.scan_error_generic', 'Error submitting scan') });
    }
    refocus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitScan();
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 700 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>🔫 Fulfill via Scan — {workOrderId}</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 15, fontSize: 13 }}>
          {t('alerts.fulfill_scan_subtitle', "Scan each item's batch barcode with the handheld scanner — it submits automatically.")}
        </p>

        <div className="table-container">
          <table style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Progress</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const color = `var(--${workOrderStatusPillClass(l.status)})`;
                return (
                  <tr key={l.id}>
                    <td>{l.item_name}</td>
                    <td>
                      {l.quantity_fulfilled || 0} / {l.quantity} {l.unit || ''}
                    </td>
                    <td>
                      <span className="pill" style={{ color, border: `1px solid ${color}`, background: 'transparent' }}>
                        {workOrderStatusLabel(l.status, t)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          placeholder={t('alerts.scan_barcode_placeholder', 'Scan barcode...')}
          style={{
            width: '100%',
            padding: 12,
            fontSize: 16,
            margin: '15px 0',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(0,0,0,0.3)',
            color: 'white',
          }}
          onKeyDown={handleKeyDown}
          onBlur={refocus}
        />

        {feedback && (
          <div
            style={{
              padding: 10,
              marginTop: 10,
              borderRadius: 6,
              background: feedback.kind === 'success' ? 'rgba(16,185,129,0.15)' : feedback.kind === 'fefo' ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
              color: feedback.kind === 'success' ? 'var(--ok)' : feedback.kind === 'fefo' ? 'var(--warn)' : 'var(--danger)',
            }}
          >
            {feedback.kind === 'success' && <>✅ {feedback.text}</>}
            {feedback.kind === 'error' && <>❌ {feedback.text}</>}
            {feedback.kind === 'fefo' && (
              <>
                ⚠️ {feedback.message}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ borderColor: 'var(--warn)', color: 'var(--warn)', padding: '4px 10px', fontSize: 12 }}
                    onClick={() => submitScan(feedback.barcode, true)}
                  >
                    {t('alerts.scan_anyway', 'Scan Anyway')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
