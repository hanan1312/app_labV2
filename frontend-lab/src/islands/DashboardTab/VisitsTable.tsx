import type { CSSProperties } from 'react';

export interface VisitRow {
  id?: number; // absent for the "total" view's unbooked-client placeholder rows
  visit_id: string;
  patient_id: number;
  patient_name: string;
  date: string;
  tests: string[];
  completed_tests?: string[];
  status: string;
  phone?: string;
  physician_name?: string;
}

type TFunc = (path: string, fallback: string, vars?: Record<string, string | number>) => string;

// Mirrors buildAdminTableHTML()'s per-status badge in script_lab.js — a faithful port of the
// actual reachable branches (its status === 'collected' clause appears twice in the vanilla
// if/else-if chain; the second occurrence is unreachable dead code since the first already
// matches, so only the dropdown behavior it actually produces is replicated here).
function statusBadge(row: VisitRow, t: TFunc): { pillClass: string; text: string; countBadge?: string } {
  switch (row.status) {
    case 'registered':
      return { pillClass: 'info', text: t('alerts.status_registered', 'Registered') };
    case 'pending':
      return { pillClass: 'danger', text: t('alerts.status_pending_badge', 'Pending') };
    case 'collected':
      return { pillClass: 'ok', text: t('alerts.status_waiting_results', 'Waiting for Results') };
    case 'partially_delivered': {
      const total = row.tests?.length || 0;
      const done = row.completed_tests?.length || 0;
      const text = done
        ? t('alerts.status_delivered_suffix', '{tests} Delivered', { tests: (row.completed_tests || []).join(', ') })
        : t('alerts.status_partially_delivered', 'Partially Delivered');
      return { pillClass: 'info', text, countBadge: `${done}/${total}` };
    }
    case 'awaiting_approval':
      return { pillClass: 'warn', text: t('alerts.status_awaiting_approval', 'Waiting for Approval') };
    case 'results_delivered_by_link':
      return { pillClass: 'info', text: t('alerts.status_delivered', 'Delivered') };
    default:
      return { pillClass: 'ghost', text: t('alerts.status_pending_badge', 'Pending') };
  }
}

function RowActions({ row, t, onCollectSample }: { row: VisitRow; t: TFunc; onCollectSample: (visitId: string) => void }) {
  const dropdownContentStyle: CSSProperties = {
    display: 'none',
    position: 'absolute',
    right: 0,
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    zIndex: 100,
    minWidth: 160,
  };

  switch (row.status) {
    case 'registered':
      return (
        <button className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={() => window.openBookTestModal(row.patient_id)}>
          {t('alerts.btn_order_now', 'Order Now')}
        </button>
      );
    case 'collected':
      return (
        <div className="action-dropdown" style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn ghost">{t('alerts.action_menu_label', 'Action ▾')}</button>
          <div className="action-dropdown-content" style={dropdownContentStyle}>
            <button onClick={() => window.openBookTestModal(row.patient_id)}>{t('alerts.btn_new_order', '📋 New Order')}</button>
            <button
              onClick={() =>
                window.open(`/results-entry/${row.id}`, 'EnterResults', 'width=1000,height=800,resizable=yes,scrollbars=yes')
              }
            >
              {t('alerts.btn_enter_results', '🧪 Enter Results')}
            </button>
            <button onClick={() => window.openUploadModal(row.visit_id, row.patient_id, row.patient_name)}>
              {t('alerts.btn_upload_pdf_report', '📤 Upload PDF Report')}
            </button>
            <button onClick={() => window.quickEditPatient(row.patient_id)}>{t('alerts.btn_edit_patient', '✏️ Edit Patient')}</button>
          </div>
        </div>
      );
    case 'results_delivered_by_link':
      return (
        <div className="action-dropdown" style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn ghost">{t('alerts.action_menu_label', 'Action ▾')}</button>
          <div className="action-dropdown-content" style={dropdownContentStyle}>
            <button onClick={() => window.printPDFReport(row.visit_id)}>{t('alerts.btn_print_report', '🖨️ Print Report')}</button>
            <button onClick={() => window.openUploadModal(row.visit_id, row.patient_id, row.patient_name)}>
              {t('alerts.btn_upload_additional_pdf', '📤 Upload Additional PDF')}
            </button>
            <button onClick={() => window.openBookTestModal(row.patient_id)}>{t('alerts.btn_new_order', '📋 New Order')}</button>
            <button onClick={() => window.quickEditPatient(row.patient_id)}>{t('alerts.btn_edit_patient', '✏️ Edit Patient')}</button>
          </div>
        </div>
      );
    case 'partially_delivered':
      return (
        <div className="action-dropdown" style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn ghost">{t('alerts.action_menu_label', 'Action ▾')}</button>
          <div className="action-dropdown-content" style={dropdownContentStyle}>
            <button onClick={() => window.printPDFReport(row.visit_id)}>{t('alerts.btn_print_report', '🖨️ Print Report')}</button>
            <button
              onClick={() =>
                window.open(`/results-entry/${row.id}`, 'EnterResults', 'width=1000,height=800,resizable=yes,scrollbars=yes')
              }
            >
              {t('alerts.btn_enter_results', '🧪 Enter Results')}
            </button>
            <button onClick={() => window.openUploadModal(row.visit_id, row.patient_id, row.patient_name)}>
              {t('alerts.btn_upload_pdf_report', '📤 Upload PDF Report')}
            </button>
            <button onClick={() => window.openBookTestModal(row.patient_id)}>{t('alerts.btn_new_order', '📋 New Order')}</button>
            <button onClick={() => window.quickEditPatient(row.patient_id)}>{t('alerts.btn_edit_patient', '✏️ Edit Patient')}</button>
          </div>
        </div>
      );
    case 'awaiting_approval':
      // Approval itself happens in bulk via Test Results > Check (approve_results
      // permission) — no per-row "approve" action here on purpose, matching buildAdminTableHTML.
      return (
        <div className="action-dropdown" style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn ghost">{t('alerts.action_menu_label', 'Action ▾')}</button>
          <div className="action-dropdown-content" style={dropdownContentStyle}>
            <button onClick={() => window.printPDFReport(row.visit_id)}>{t('alerts.btn_print_report', '🖨️ Print Report')}</button>
            <button onClick={() => window.openUploadModal(row.visit_id, row.patient_id, row.patient_name)}>
              {t('alerts.btn_upload_additional_pdf', '📤 Upload Additional PDF')}
            </button>
            <button onClick={() => window.openBookTestModal(row.patient_id)}>{t('alerts.btn_new_order', '📋 New Order')}</button>
            <button onClick={() => window.quickEditPatient(row.patient_id)}>{t('alerts.btn_edit_patient', '✏️ Edit Patient')}</button>
          </div>
        </div>
      );
    case 'pending':
      return (
        <button
          className="btn ghost"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
          onClick={() => onCollectSample(row.visit_id)}
        >
          {t('alerts.btn_collect_sample', '🧪 Collect Sample')}
        </button>
      );
    default:
      return null;
  }
}

export default function VisitsTable({
  title,
  rows,
  startIndex,
  clickable,
  selected,
  onToggleRow,
  onToggleAll,
  onCollectSample,
  onRowClick,
  onBulkDelete,
  extraBulkAction,
  exportFilename,
  containerId,
  t,
}: {
  title: string;
  rows: VisitRow[];
  startIndex: number;
  clickable: boolean;
  selected: Set<number>;
  onToggleRow: (id: number, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onCollectSample: (visitId: string) => void;
  onRowClick: (id: number) => void;
  onBulkDelete: () => void;
  // Optional second bulk action next to "Delete Selected" — e.g. Pending Samples' "Finish
  // Selected" (mark all checked visits collected). Vanilla's equivalent
  // (updateBulkFinishButton()/handleBulkFinish()) never actually worked — its checkbox
  // selector (.pending-checkbox) didn't match what buildAdminTableHTML renders
  // (.visit-checkbox) — so this is a from-scratch (but intent-faithful) implementation, not a
  // port of working code.
  extraBulkAction?: { label: string; onClick: (selectedIds: number[]) => void };
  exportFilename: string;
  containerId: string;
  t: TFunc;
}) {
  const selectableIds = rows.filter((r) => r.id != null).map((r) => r.id as number);
  const allChecked = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
        <h3 style={{ margin: 0, color: 'var(--text)' }}>{title}</h3>
        {selected.size > 0 && extraBulkAction && (
          <button
            className="btn"
            style={{ background: 'var(--ok)', color: 'white', padding: '6px 12px', fontSize: 12, marginLeft: 'auto', marginRight: 8 }}
            onClick={() => extraBulkAction.onClick([...selected])}
          >
            {extraBulkAction.label}
          </button>
        )}
        {selected.size > 0 && (
          <button
            className="btn btn-danger"
            style={{ padding: '6px 12px', fontSize: 12, marginLeft: extraBulkAction ? 0 : 'auto', marginRight: 8 }}
            onClick={onBulkDelete}
          >
            🗑️ <span>{t('actions.delete_selected', 'Delete Selected')}</span>
          </button>
        )}
        <button
          className="btn ghost"
          style={{ borderColor: 'var(--ok)', color: 'var(--ok)', padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={(e) => window.exportTableToExcel(e.currentTarget, exportFilename, `#${containerId} .table-container`)}
        >
          📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
        </button>
      </div>
      <div id={containerId} className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" checked={allChecked} onChange={(e) => onToggleAll(e.target.checked)} />
              </th>
              <th>{t('alerts.th_hash', '#')}</th>
              <th>{t('alerts.th_date_created', 'Date Created')}</th>
              <th>{t('alerts.th_trans_id', 'Trans ID')}</th>
              <th>{t('alerts.th_patient', 'Patient')}</th>
              <th>{t('alerts.th_phone', 'Phone')}</th>
              <th>{t('alerts.th_physician', 'Physician')}</th>
              <th>{t('alerts.th_tests', 'Tests')}</th>
              <th>{t('alerts.th_status', 'Status')}</th>
              <th style={{ textAlign: 'right' }}>{t('alerts.th_action', 'Action')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                  {t('alerts.no_entries_match_filters', 'No entries match your filters.')}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const badge = statusBadge(row, t);
                const isClickable = clickable && row.id != null && row.status !== 'registered';
                return (
                  <tr
                    key={row.id ?? `unbooked-${row.patient_id}`}
                    onClick={
                      isClickable
                        ? (e) => {
                            // Ignores clicks inside the checkbox/action cells rather than
                            // stopping propagation there — the Action ▾ dropdown is opened by
                            // a document-level click listener (script_lab.js) that needs the
                            // click to keep bubbling all the way up to `document`.
                            if (!(e.target as HTMLElement).closest('.no-row-click')) onRowClick(row.id as number);
                          }
                        : undefined
                    }
                    style={isClickable ? { cursor: 'pointer' } : undefined}
                    title={isClickable ? t('alerts.title_view_results', 'View results') : undefined}
                  >
                    <td className="no-row-click">
                      {row.id != null && (
                        <input type="checkbox" checked={selected.has(row.id)} onChange={(e) => onToggleRow(row.id as number, e.target.checked)} />
                      )}
                    </td>
                    <td>{startIndex + index + 1}</td>
                    <td style={{ color: 'var(--muted)' }}>{window.formatCairoDateTime(row.date, false)}</td>
                    <td>
                      <strong>{row.visit_id}</strong>
                    </td>
                    <td>{row.patient_name}</td>
                    <td style={{ color: 'var(--muted)' }}>{row.phone || 'N/A'}</td>
                    <td style={{ color: 'var(--muted)' }}>{row.physician_name && row.physician_name !== 'Self' ? row.physician_name : '-'}</td>
                    <td>{row.tests.join(', ')}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ position: 'relative', display: 'inline-block' }}>
                        <span className={`pill ${badge.pillClass}`}>{badge.text}</span>
                        {badge.countBadge && (
                          <span
                            style={{
                              position: 'absolute',
                              top: -8,
                              right: -10,
                              background: 'var(--danger)',
                              color: 'white',
                              borderRadius: '50%',
                              padding: '1px 5px',
                              fontSize: 9,
                              fontWeight: 'bold',
                              minWidth: 14,
                              textAlign: 'center',
                              lineHeight: 1.4,
                              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                            }}
                          >
                            {badge.countBadge}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="no-row-click" style={{ textAlign: 'right' }}>
                      <RowActions row={row} t={t} onCollectSample={onCollectSample} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
