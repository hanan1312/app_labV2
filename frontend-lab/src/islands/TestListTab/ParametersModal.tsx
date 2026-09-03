import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

interface ParameterRow {
  id: number | null;
  name: string;
  unit: string;
  method: string;
  gender_specific: boolean;
  ref_low: string;
  ref_high: string;
  ref_low_male: string;
  ref_high_male: string;
  ref_low_female: string;
  ref_high_female: string;
  reference_range_text: string;
  abnormal_note: string;
  relation_formula: string;
  absolute_count_formula: string;
  absolute_count_unit: string;
  absolute_ref_low: string;
  absolute_ref_high: string;
  category: string;
  parent_parameter_id: number | null;
  _parentRowIndex: number | null;
}

type FormulaField = 'relation_formula' | 'absolute_count_formula';

const BLANK_ROW: ParameterRow = {
  id: null,
  name: '',
  unit: '',
  method: '',
  gender_specific: false,
  ref_low: '',
  ref_high: '',
  ref_low_male: '',
  ref_high_male: '',
  ref_low_female: '',
  ref_high_female: '',
  reference_range_text: '',
  abnormal_note: '',
  relation_formula: '',
  absolute_count_formula: '',
  absolute_count_unit: '',
  absolute_ref_low: '',
  absolute_ref_high: '',
  category: '',
  parent_parameter_id: null,
  _parentRowIndex: null,
};

// The server stores/validates formulas with stable {id} tokens (e.g. "{55} / {56} * 2") so
// renaming a parameter never breaks a formula that references it. The modal shows/edits a
// friendlier "[Name]" form instead — these two convert between them, same as the vanilla
// formulaToDisplay()/formulaToStored() (script_lab.js).
function formulaToDisplay(formula: string, rows: ParameterRow[]): string {
  if (!formula) return '';
  return formula.replace(/\{(\d+)\}/g, (match, idStr) => {
    const referenced = rows.find((r) => r.id === parseInt(idStr, 10));
    return referenced ? `[${referenced.name}]` : match; // dangling ref (deleted param) - left as-is
  });
}

function formulaToStored(display: string, rows: ParameterRow[]): string {
  if (!display) return '';
  let cleaned = display.trim();
  if (cleaned.startsWith('=')) cleaned = cleaned.slice(1).trim(); // "=" is just familiar Excel styling
  return cleaned.replace(/\[([^\]]+)\]/g, (match, name) => {
    const referenced = rows.find((r) => r.name && r.name.trim() === name.trim());
    return referenced && referenced.id ? `{${referenced.id}}` : match; // unresolved - backend will reject
  });
}

function numOrNull(v: string): number | null {
  return v === '' || v == null ? null : parseFloat(v);
}

export default function ParametersModal({
  open,
  testId,
  testName,
  onClose,
}: {
  open: boolean;
  testId: number | null;
  testName: string;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const [rows, setRows] = useState<ParameterRow[]>([]);
  const deletedIdsRef = useRef<number[]>([]);
  // Which row/field (relation_formula or absolute_count_formula - a parameter can have both)
  // last had focus, and where its caret was - the 🔗 button next to another row's name
  // inserts a [Name] reference there. Doesn't need to be state: nothing re-renders off it.
  const activeFormulaTargetRef = useRef<{ rowIndex: number; field: FormulaField } | null>(null);
  const formulaInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    if (!open || testId == null) return;
    deletedIdsRef.current = [];
    activeFormulaTargetRef.current = null;

    (async () => {
      let loaded: ParameterRow[] = [];
      try {
        const res = await apiFetch(`/api/lab-tests/${testId}/parameters`);
        loaded = res.ok ? await res.json() : [];
      } catch (err) {
        window.showAlert(
          t('alerts.parameters_load_error', 'Could not load parameters: {msg}', { msg: err instanceof Error ? err.message : String(err) }),
          'error'
        );
      }
      loaded.forEach((row) => {
        row.relation_formula = formulaToDisplay(row.relation_formula || '', loaded);
        row.absolute_count_formula = formulaToDisplay(row.absolute_count_formula || '', loaded);
        // parent_parameter_id (a real DB id, when loaded) is tracked in the modal as an array
        // index instead (_parentRowIndex) - a newly-added row has no id yet, so the "Parent
        // Parameter" dropdown references rows by position, resolved back to real ids at save
        // time (see handleSave()'s pass 2), same reasoning as the {id}-token formulas.
        const parentIdx = row.parent_parameter_id ? loaded.findIndex((r) => r.id === row.parent_parameter_id) : -1;
        row._parentRowIndex = parentIdx >= 0 ? parentIdx : null;
      });
      setRows(loaded);
    })();
  }, [open, testId]);

  function updateRow(idx: number, patch: Partial<ParameterRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { ...BLANK_ROW }]);
  }

  function removeRow(idx: number) {
    setRows((prev) => {
      const row = prev[idx];
      if (row.id) deletedIdsRef.current.push(row.id);
      const next = prev.filter((_, i) => i !== idx);
      // _parentRowIndex references are positional - removing a row shifts every later index,
      // so a row parented to the one just removed must fall back to top-level rather than
      // silently pointing at whatever row slides into that slot.
      return next.map((r) => {
        if (r._parentRowIndex == null) return r;
        if (r._parentRowIndex === idx) return { ...r, _parentRowIndex: null };
        if (r._parentRowIndex > idx) return { ...r, _parentRowIndex: r._parentRowIndex - 1 };
        return r;
      });
    });
    if (activeFormulaTargetRef.current?.rowIndex === idx) activeFormulaTargetRef.current = null;
  }

  function trackFormulaCaret(rowIndex: number, field: FormulaField, input: HTMLInputElement) {
    activeFormulaTargetRef.current = { rowIndex, field };
    formulaInputRefs.current.set(`${rowIndex}:${field}`, input);
  }

  // Excel-like "click a cell to insert its reference" - inserts "[Name]" at the last-known
  // caret position of whichever Formula field was last focused. namedIdx is the row whose 🔗
  // was clicked (the parameter being referenced), not the formula being edited.
  function insertParamReference(namedIdx: number) {
    const target = activeFormulaTargetRef.current;
    if (!target) {
      window.showAlert(
        t('alerts.formula_click_field_first', "Click into a Formula field first, then click a parameter's 🔗 to insert it."),
        'error'
      );
      return;
    }
    const { rowIndex, field } = target;
    // Self-reference is meaningless for relation_formula (a value can't be derived from
    // itself) but is the common case for absolute_count_formula (e.g. Absolute Neutrophil
    // Count = Neutrophils% * WBC / 100 references Neutrophils' own value).
    if (namedIdx === rowIndex && field === 'relation_formula') {
      window.showAlert(t('alerts.formula_self_reference', 'A parameter cannot reference itself.'), 'error');
      return;
    }
    const namedRow = rows[namedIdx];
    if (!namedRow || !namedRow.name.trim()) {
      window.showAlert(t('alerts.name_parameter_first', 'Name that parameter before referencing it.'), 'error');
      return;
    }

    const inputKey = `${rowIndex}:${field}`;
    const input = formulaInputRefs.current.get(inputKey);
    const current = rows[rowIndex][field] || '';
    const pos = input?.selectionStart ?? current.length;
    const insertText = `[${namedRow.name.trim()}]`;
    const newValue = current.slice(0, pos) + insertText + current.slice(pos);
    updateRow(rowIndex, { [field]: newValue } as Partial<ParameterRow>);

    requestAnimationFrame(() => {
      const refreshedInput = formulaInputRefs.current.get(inputKey);
      if (!refreshedInput) return;
      refreshedInput.focus();
      const newPos = pos + insertText.length;
      refreshedInput.setSelectionRange(newPos, newPos);
      activeFormulaTargetRef.current = { rowIndex, field };
    });
  }

  async function handleSave() {
    if (testId == null) return;
    try {
      for (const id of deletedIdsRef.current) {
        await apiFetch(`/api/parameters/${id}`, { method: 'DELETE' });
      }

      // Pass 1: save every row's own fields (not its relation - a "Parent Parameter" selection
      // may point at another row that doesn't have a real id yet either, so relations are only
      // resolvable once every row here has been created/updated at least once).
      const working = [...rows];
      for (let i = 0; i < working.length; i++) {
        const row = working[i];
        if (!row.name.trim()) continue; // skip blank rows silently

        const payload = {
          name: row.name,
          unit: row.unit || null,
          method: row.method || null,
          ref_low: numOrNull(row.ref_low),
          ref_high: numOrNull(row.ref_high),
          reference_range_text: row.reference_range_text || null,
          abnormal_note: row.abnormal_note || null,
          gender_specific: !!row.gender_specific,
          ref_low_male: numOrNull(row.ref_low_male),
          ref_high_male: numOrNull(row.ref_high_male),
          ref_low_female: numOrNull(row.ref_low_female),
          ref_high_female: numOrNull(row.ref_high_female),
          absolute_count_unit: row.absolute_count_unit || null,
          absolute_ref_low: numOrNull(row.absolute_ref_low),
          absolute_ref_high: numOrNull(row.absolute_ref_high),
          category: row.category || null,
        };

        if (row.id) {
          await apiFetch(`/api/parameters/${row.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          const res = await apiFetch(`/api/lab-tests/${testId}/parameters`, { method: 'POST', body: JSON.stringify(payload) });
          if (res.ok) working[i] = { ...row, id: (await res.json()).id };
        }
      }

      // Pass 2: now that every saved row has a real id, resolve each formula's "[Name]"
      // references (which may point at a row that only just got its id in pass 1 above) into
      // the stable "{id}" tokens the server stores and validates. Sent as separate requests
      // (not combined into one payload) since the backend validates each field independently
      // and bails on the first error - combining them would let an invalid relation_formula
      // block an otherwise-valid absolute_count_formula from saving too.
      for (const row of working) {
        if (!row.id) continue; // blank row skipped above - nothing to attach a formula to

        const relationRes = await apiFetch(`/api/parameters/${row.id}`, {
          method: 'PUT',
          body: JSON.stringify({ relation_formula: formulaToStored(row.relation_formula || '', working) || null }),
        });
        if (!relationRes.ok) {
          const body = await relationRes.json().catch(() => ({}));
          window.showAlert(
            t('alerts.formula_not_saved', 'Formula for "{name}" was not saved: {error}', { name: row.name, error: body.error || t('alerts.hr_unknown_error', 'unknown error') }),
            'error'
          );
        }

        const absoluteRes = await apiFetch(`/api/parameters/${row.id}`, {
          method: 'PUT',
          body: JSON.stringify({ absolute_count_formula: formulaToStored(row.absolute_count_formula || '', working) || null }),
        });
        if (!absoluteRes.ok) {
          const body = await absoluteRes.json().catch(() => ({}));
          window.showAlert(
            t('alerts.absolute_formula_not_saved', 'Absolute Count formula for "{name}" was not saved: {error}', { name: row.name, error: body.error || t('alerts.hr_unknown_error', 'unknown error') }),
            'error'
          );
        }

        // Same reasoning as the formulas above: a chosen parent may only just have gotten its
        // real id in pass 1, so this resolves _parentRowIndex -> a real id last.
        const parentId = row._parentRowIndex != null && working[row._parentRowIndex] ? working[row._parentRowIndex].id : null;
        const parentRes = await apiFetch(`/api/parameters/${row.id}`, {
          method: 'PUT',
          body: JSON.stringify({ parent_parameter_id: parentId }),
        });
        if (!parentRes.ok) {
          const body = await parentRes.json().catch(() => ({}));
          window.showAlert(
            t('alerts.parent_parameter_not_saved', 'Parent parameter for "{name}" was not saved: {error}', { name: row.name, error: body.error || t('alerts.hr_unknown_error', 'unknown error') }),
            'error'
          );
        }
      }

      window.showAlert(t('alerts.parameters_saved', 'Parameters saved!'), 'success');
      onClose();
    } catch (err) {
      window.showAlert(t('alerts.parameters_save_error', 'Error saving parameters: {msg}', { msg: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  const numberInputStyle = { width: '100%', minWidth: 70 };
  const textInputStyle = { width: '100%', minWidth: 70 };

  return (
    <div id="parameters-modal" className="modal" style={{ display: open ? 'block' : 'none' }}>
      <div className="modal-content glass-panel">
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>{t('modals.parameters_title', 'Result Parameters')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>{testName}</p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
          {t('modals.parameters_hint', 'These rows appear as the results-entry table for this test on every visit that books it.')}
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
          {t(
            'modals.parameters_formula_hint',
            '"Formula" auto-calculates a parameter\'s value from others during results entry, Excel-style: click into a Formula field, click the 🔗 next to another parameter\'s name to insert it, then type an operator — e.g. "[WBC] / [RBC] * 2".'
          )}
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
          {t(
            'modals.parameters_absolute_hint',
            '"Absolute Count" is a separate computed value with its own unit and reference range (e.g. Absolute Neutrophil Count) — its formula works the same way and, unlike "Formula", may reference the parameter\'s own value, e.g. "[Neutrophils] / 100 * [WBC]".'
          )}
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
          {t(
            'modals.parameters_category_hint',
            '"Section" splits the report into named groups (e.g. "Blood Picture" / "Differential Count") once a test has 2 or more — leave blank to keep this test\'s report as one flat table. "Parent Parameter" nests a row under another within the same section (e.g. "Segmented"/"Band" under "Neutrophil").'
          )}
        </p>

        <div className="table-container">
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('forms.param_name', 'Name')}</th>
                <th>{t('forms.param_unit', 'Unit')}</th>
                <th>{t('forms.param_method', 'Method')}</th>
                <th title="Different reference range for male/female">M/F</th>
                <th>{t('forms.param_ref_low', 'Ref. Low / High')}</th>
                <th>{t('forms.param_ref_text', 'Ref. Range (display)')}</th>
                <th>{t('forms.param_abnormal_note', 'Abnormal Interpretation')}</th>
                <th title="Click into this field, then click the 🔗 next to another parameter's name to insert it, e.g. [WBC] / [RBC] * 2">
                  {t('forms.param_formula', 'Formula')}
                </th>
                <th title="A separate computed value — may reference this parameter's own value, e.g. [Neutrophils] / 100 * [WBC]">
                  {t('forms.param_absolute_formula', 'Absolute Count Formula')}
                </th>
                <th>{t('forms.param_absolute_unit', 'Absolute Unit')}</th>
                <th>{t('forms.param_absolute_ref', 'Absolute Ref. Low/High')}</th>
                <th title="Groups this parameter into a named report section (e.g. 'Blood Picture') — a test with 2+ distinct sections renders as a categorized report instead of one flat table.">
                  {t('forms.param_category', 'Section')}
                </th>
                <th title="Nest this parameter as a sub-row under another (e.g. 'Segmented'/'Band' under 'Neutrophil') — only used within a categorized section.">
                  {t('forms.param_parent', 'Parent Parameter')}
                </th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={14} style={{ textAlign: 'center', color: 'var(--muted)', padding: 15 }}>
                    {t('alerts.empty_no_parameters_yet', 'No parameters yet — click "+ Add Parameter" below.')}
                  </td>
                </tr>
              ) : (
                rows.map((row, idx) => {
                  const parentOptions = rows
                    .map((r, i) => ({ r, i }))
                    .filter(({ r, i }) => i !== idx && r.name.trim() && r._parentRowIndex == null);

                  return (
                    <tr key={idx}>
                      <td style={{ minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input
                            type="text"
                            style={textInputStyle}
                            value={row.name}
                            onChange={(e) => updateRow(idx, { name: e.target.value })}
                          />
                          <button
                            type="button"
                            title="Insert this parameter into the active Formula field"
                            onClick={() => insertParamReference(idx)}
                            style={{
                              flexShrink: 0,
                              padding: '3px 7px',
                              fontSize: 12,
                              cursor: 'pointer',
                              borderRadius: 4,
                              border: '1px solid var(--border)',
                              background: 'var(--bg-2)',
                              color: 'var(--text)',
                            }}
                          >
                            🔗
                          </button>
                        </div>
                      </td>
                      <td>
                        <input type="text" style={textInputStyle} value={row.unit} onChange={(e) => updateRow(idx, { unit: e.target.value })} />
                      </td>
                      <td>
                        <input type="text" style={textInputStyle} value={row.method} onChange={(e) => updateRow(idx, { method: e.target.value })} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={row.gender_specific}
                          title="Different reference range for male/female"
                          onChange={(e) => updateRow(idx, { gender_specific: e.target.checked })}
                        />
                      </td>
                      <td style={{ minWidth: 170 }}>
                        {row.gender_specific ? (
                          <>
                            <MiniField label="M ↓" value={row.ref_low_male} onChange={(v) => updateRow(idx, { ref_low_male: v })} />
                            <MiniField label="M ↑" value={row.ref_high_male} onChange={(v) => updateRow(idx, { ref_high_male: v })} />
                            <MiniField label="F ↓" value={row.ref_low_female} onChange={(v) => updateRow(idx, { ref_low_female: v })} />
                            <MiniField label="F ↑" value={row.ref_high_female} onChange={(v) => updateRow(idx, { ref_high_female: v })} />
                          </>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input type="number" style={numberInputStyle} value={row.ref_low} onChange={(e) => updateRow(idx, { ref_low: e.target.value })} />
                            <input type="number" style={numberInputStyle} value={row.ref_high} onChange={(e) => updateRow(idx, { ref_high: e.target.value })} />
                          </div>
                        )}
                      </td>
                      <td>
                        <input
                          type="text"
                          style={textInputStyle}
                          value={row.reference_range_text}
                          onChange={(e) => updateRow(idx, { reference_range_text: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          style={textInputStyle}
                          value={row.abnormal_note}
                          onChange={(e) => updateRow(idx, { abnormal_note: e.target.value })}
                        />
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <input
                          type="text"
                          style={{ width: '100%', minWidth: 200 }}
                          value={row.relation_formula}
                          placeholder="= click a parameter's 🔗, then an operator, e.g. [WBC] / [RBC] * 2"
                          onChange={(e) => updateRow(idx, { relation_formula: e.target.value })}
                          onFocus={(e) => trackFormulaCaret(idx, 'relation_formula', e.currentTarget)}
                          onClick={(e) => trackFormulaCaret(idx, 'relation_formula', e.currentTarget)}
                          onKeyUp={(e) => trackFormulaCaret(idx, 'relation_formula', e.currentTarget)}
                          ref={(el) => {
                            if (el) formulaInputRefs.current.set(`${idx}:relation_formula`, el);
                          }}
                        />
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <input
                          type="text"
                          style={{ width: '100%', minWidth: 200 }}
                          value={row.absolute_count_formula}
                          placeholder="= e.g. [Neutrophils] / 100 * [WBC]"
                          onChange={(e) => updateRow(idx, { absolute_count_formula: e.target.value })}
                          onFocus={(e) => trackFormulaCaret(idx, 'absolute_count_formula', e.currentTarget)}
                          onClick={(e) => trackFormulaCaret(idx, 'absolute_count_formula', e.currentTarget)}
                          onKeyUp={(e) => trackFormulaCaret(idx, 'absolute_count_formula', e.currentTarget)}
                          ref={(el) => {
                            if (el) formulaInputRefs.current.set(`${idx}:absolute_count_formula`, el);
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          style={textInputStyle}
                          value={row.absolute_count_unit}
                          onChange={(e) => updateRow(idx, { absolute_count_unit: e.target.value })}
                        />
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input
                            type="number"
                            style={numberInputStyle}
                            value={row.absolute_ref_low}
                            onChange={(e) => updateRow(idx, { absolute_ref_low: e.target.value })}
                          />
                          <input
                            type="number"
                            style={numberInputStyle}
                            value={row.absolute_ref_high}
                            onChange={(e) => updateRow(idx, { absolute_ref_high: e.target.value })}
                          />
                        </div>
                      </td>
                      <td style={{ minWidth: 110 }}>
                        <input type="text" style={textInputStyle} value={row.category} onChange={(e) => updateRow(idx, { category: e.target.value })} />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <select
                          style={{ width: '100%', minWidth: 120 }}
                          value={row._parentRowIndex ?? ''}
                          onChange={(e) => updateRow(idx, { _parentRowIndex: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                        >
                          <option value="">—</option>
                          {parentOptions.map(({ r, i }) => (
                            <option key={i} value={i}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ cursor: 'pointer', color: 'var(--danger)', fontSize: 18 }} onClick={() => removeRow(idx)}>
                          &times;
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 15, textAlign: 'left' }}>
          <button type="button" className="btn ghost" onClick={addRow}>
            {t('actions.add_parameter', '+ Add Parameter')}
          </button>
        </div>

        <div style={{ textAlign: 'right', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('actions.cancel', 'Cancel')}
          </button>
          <button type="button" className="btn" style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }} onClick={handleSave}>
            {t('actions.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', width: 28 }}>{label}</span>
      <input type="number" style={{ width: '100%', minWidth: 70 }} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
