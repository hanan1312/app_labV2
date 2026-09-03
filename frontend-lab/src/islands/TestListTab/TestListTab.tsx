import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import ParametersModal from './ParametersModal';
import { exportTestsWithParameters, processExcelImport } from './excelImportExport';

interface LabTest {
  id: number;
  name: string;
  sample_type?: string;
  price: number | string;
}

interface ModalState {
  open: boolean;
  editingId: number | null;
  name: string;
  sampleType: string;
  price: string;
}

const CLOSED_MODAL: ModalState = { open: false, editingId: null, name: '', sampleType: '', price: '' };

interface Panel {
  id: number;
  name: string;
  lab_test_ids: number[];
  tests: { id: number; name: string }[];
}

interface PanelFormState {
  editingId: number | null;
  name: string;
  selectedTestIds: Set<number>;
}

const NEW_PANEL_FORM: PanelFormState = { editingId: null, name: '', selectedTestIds: new Set() };

export default function TestListTab() {
  const { t } = useTranslations();
  const [tests, setTests] = useState<LabTest[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<ModalState>(CLOSED_MODAL);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelsModalOpen, setPanelsModalOpen] = useState(false);
  const [panelForm, setPanelForm] = useState<PanelFormState>(NEW_PANEL_FORM);

  const [paramsModal, setParamsModal] = useState<{ open: boolean; testId: number | null; testName: string }>({
    open: false,
    testId: null,
    testName: '',
  });

  async function refetch() {
    try {
      const res = await apiFetch('/api/tests');
      if (!res.ok) throw new Error('Failed to fetch tests');
      setTests(await res.json());
      setLoadError(false);
    } catch (err) {
      console.error('Database Error:', err);
      setLoadError(true);
    }
  }

  async function refetchPanels() {
    try {
      const res = await apiFetch('/api/panels');
      setPanels(res.ok ? await res.json() : []);
    } catch {
      setPanels([]);
    }
  }

  useEffect(() => {
    refetch();
    refetchPanels();
  }, []);

  // After this island writes (add/edit/delete), the still-vanilla availableTests global
  // (script_lab.js) — read by the Book Test modal, Test Panels, the Parameters modal, and
  // the Excel import/export engine — needs refreshing too, or those features keep showing
  // stale data until an unrelated page reload happens to re-run fetchLabTests(). Calling the
  // vanilla function directly (still declared as a real `function`, so reachable as
  // window.fetchLabTests) is simpler and more robust than trying to keep two copies of the
  // same list in sync by hand.
  async function refetchEverywhere() {
    await refetch();
    window.fetchLabTests();
  }

  // Mirrors refetchEverywhere() above: the still-vanilla Book Test modal's quick-select
  // (applyPanelQuickSelect(), script_lab.js) reads the `availablePanels` global directly,
  // populated by window.fetchPanels() — call it after any write here too.
  async function refetchPanelsEverywhere() {
    await refetchPanels();
    window.fetchPanels();
  }

  function openPanelsModal() {
    setPanelForm(NEW_PANEL_FORM);
    setPanelsModalOpen(true);
  }

  function closePanelsModal() {
    setPanelsModalOpen(false);
  }

  function editPanelForm(panel: Panel) {
    setPanelForm({ editingId: panel.id, name: panel.name, selectedTestIds: new Set(panel.lab_test_ids) });
  }

  function togglePanelTestId(id: number, checked: boolean) {
    setPanelForm((f) => {
      const next = new Set(f.selectedTestIds);
      if (checked) next.add(id);
      else next.delete(id);
      return { ...f, selectedTestIds: next };
    });
  }

  async function handleSavePanel() {
    const name = panelForm.name.trim();
    if (!name) {
      window.showAlert(t('alerts.panel_name_required', 'Panel name is required.'), 'warn');
      return;
    }
    const lab_test_ids = [...panelForm.selectedTestIds];
    if (lab_test_ids.length === 0) {
      window.showAlert(t('alerts.panel_select_one_test', 'Select at least one test for the panel.'), 'warn');
      return;
    }

    try {
      const url = panelForm.editingId ? `/api/panels/${panelForm.editingId}` : '/api/panels';
      const method = panelForm.editingId ? 'PUT' : 'POST';
      const res = await apiFetch(url, { method, body: JSON.stringify({ name, lab_test_ids }) });
      if (!res.ok) throw new Error('Server rejected panel save');
      await refetchPanelsEverywhere();
      setPanelForm(NEW_PANEL_FORM);
      window.showAlert(t('alerts.panel_saved', 'Panel saved!'), 'success');
    } catch (err) {
      window.showAlert(t('alerts.panel_save_error', 'Error saving panel: {msg}', { msg: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function handleDeletePanel(panelId: number) {
    if (!window.confirm(t('alerts.confirm_delete_panel', 'Delete this panel? This only removes the booking shortcut — no existing visits or tests are affected.'))) {
      return;
    }
    try {
      await apiFetch(`/api/panels/${panelId}`, { method: 'DELETE' });
      await refetchPanelsEverywhere();
      if (panelForm.editingId === panelId) setPanelForm(NEW_PANEL_FORM);
    } catch (err) {
      window.showAlert(t('alerts.panel_delete_error', 'Error deleting panel: {msg}', { msg: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  const searchTerm = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!searchTerm) return tests;
    return tests.filter(
      (test) =>
        test.name.toLowerCase().includes(searchTerm) || (test.sample_type || '').toLowerCase().includes(searchTerm)
    );
  }, [tests, searchTerm]);

  // Nudges toward "+ Add New Test" when a search turns up nothing — see openAddModal(),
  // which pre-fills the search term into the name field so acting on it is one click.
  const noMatchesForSearch = searchTerm !== '' && filtered.length === 0;

  function findDuplicateTestName(name: string, excludeId: number | null): LabTest | undefined {
    const normalized = name.trim().toLowerCase();
    return tests.find((test) => test.name.trim().toLowerCase() === normalized && test.id !== excludeId);
  }

  function openAddModal() {
    setModal({ open: true, editingId: null, name: noMatchesForSearch ? search.trim() : '', sampleType: '', price: '' });
  }

  function openEditModal(test: LabTest) {
    setModal({
      open: true,
      editingId: test.id,
      name: test.name,
      sampleType: test.sample_type || '',
      price: String(test.price),
    });
  }

  function closeModal() {
    setModal(CLOSED_MODAL);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    let name = modal.name.trim();
    if (!name) {
      window.showAlert(t('alerts.test_name_required', 'Test name is required.'), 'error');
      return;
    }

    // Keep prompting until the name is unique or the user cancels — Cancel aborts the save
    // entirely rather than falling back to the original (still-duplicate) name.
    let duplicate = findDuplicateTestName(name, modal.editingId);
    while (duplicate) {
      const newName = window.prompt(
        t('alerts.duplicate_test_name_prompt', 'A test named "{name}" already exists. Enter a different name to continue, or press Cancel to stop.', { name: duplicate.name }),
        ''
      );
      if (newName === null) return; // cancelled - do not save anything
      name = newName.trim();
      if (!name) {
        window.showAlert(t('alerts.test_name_required', 'Test name is required.'), 'error');
        return;
      }
      duplicate = findDuplicateTestName(name, modal.editingId);
    }

    const payload: Record<string, unknown> = { name, sample_type: modal.sampleType, price: modal.price };
    if (modal.editingId) payload.id = modal.editingId;

    try {
      const res = await apiFetch('/api/tests', { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Server rejected save request');
      closeModal();
      await refetchEverywhere();
      window.showAlert(t('alerts.test_saved_db', 'Test saved to database!'), 'success');
    } catch (err) {
      console.error('Save Error:', err);
      window.showAlert(t('alerts.test_save_db_failed', 'Failed to save to database.'), 'error');
    }
  }

  function toggleSelect(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((test) => test.id)) : new Set());
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t('alerts.confirm_delete_tests', 'Are you sure you want to delete {count} test(s)? This cannot be undone.', { count: ids.length }))) {
      return;
    }

    // Checked individually — a test still referenced by a booked visit, transaction, or
    // panel is blocked server-side (409) instead of silently failing, and a bare success
    // count would otherwise hide exactly why nothing got deleted.
    let successCount = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/tests/${id}`, { method: 'DELETE' });
        if (res.ok) {
          successCount++;
        } else {
          const body = await res.json().catch(() => ({}));
          failures.push(body.error || `#${id}: ${res.status}`);
        }
      } catch (err) {
        failures.push(`#${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failures.length === 0) {
      window.showAlert(t('alerts.tests_deleted', 'Successfully deleted {count} tests!', { count: successCount }), 'success');
    } else if (successCount === 0) {
      window.showAlert(t('alerts.tests_delete_error', 'Error deleting tests: {msg}', { msg: failures.join('; ') }), 'error');
    } else {
      window.showAlert(
        t('alerts.tests_delete_partial', 'Deleted {ok} test(s); {failed} failed: {msg}', {
          ok: successCount,
          failed: failures.length,
          msg: failures.join('; '),
        }),
        'error'
      );
    }

    setSelectedIds(new Set());
    await refetchEverywhere();
  }

  const allChecked = filtered.length > 0 && filtered.every((test) => selectedIds.has(test.id));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1>{t('tests.title', 'Test Directory')}</h1>
          <p style={{ color: 'var(--muted)' }}>{t('tests.subtitle', 'Manage available laboratory tests and pricing')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {selectedIds.size > 0 && (
            <button className="btn btn-danger" onClick={handleBulkDelete}>
              {t('actions.delete_selected', 'Delete Selected')}
            </button>
          )}

          <button
            className="btn ghost"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            onClick={() => exportTestsWithParameters(tests, t)}
          >
            📥 <span>{t('actions.export_excel', 'Export to Excel')}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            id="import-excel-file"
            accept=".xlsx, .xls, .csv"
            style={{ display: 'none' }}
            onChange={(e) => processExcelImport(e.nativeEvent, tests, t, refetchEverywhere)}
          />
          <button
            className="btn ghost"
            style={{ borderColor: '#3b82f6', color: '#3b82f6' }}
            onClick={() => fileInputRef.current?.click()}
          >
            📤 Import Excel
          </button>

          <button className="btn ghost" style={{ borderColor: 'var(--teal)', color: 'var(--teal)' }} onClick={openPanelsModal}>
            🗂 Manage Panels
          </button>

          <button
            className={`btn${noMatchesForSearch ? ' btn-attention' : ''}`}
            style={{ background: 'var(--teal)', color: '#04121d', fontWeight: 'bold' }}
            onClick={openAddModal}
          >
            + <span>{t('modals.add_test', 'Add New Test')}</span>
          </button>
        </div>
      </div>

      <div className="search-box" style={{ margin: '0 0 20px 0', maxWidth: 400 }}>
        <span className="search-icon">⌕</span>
        <input
          type="text"
          placeholder={t('tests.search_placeholder', 'Search tests by name or sample type...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-container">
        {loadError ? (
          <p style={{ color: 'var(--warn)', padding: 20 }}>Could not connect to database.</p>
        ) : tests.length === 0 ? (
          <table style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                  {t('alerts.empty_no_tests_available', 'No tests available. Click "Add New Test" to begin.')}
                </td>
              </tr>
            </tbody>
          </table>
        ) : noMatchesForSearch ? (
          <table style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                  {t('alerts.empty_no_tests_match_search', 'No tests match "{term}" — click "+ Add New Test" to create it.', { term: search.trim() })}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input type="checkbox" checked={allChecked} onChange={(e) => toggleSelectAll(e.target.checked)} />
                </th>
                <th style={{ width: 80 }}>ID</th>
                <th>Test Name</th>
                <th>Sample Type</th>
                <th style={{ width: 150 }}>Price</th>
                <th style={{ textAlign: 'right', width: 150 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((test) => (
                <tr key={test.id}>
                  <td>
                    <input type="checkbox" checked={selectedIds.has(test.id)} onChange={(e) => toggleSelect(test.id, e.target.checked)} />
                  </td>
                  <td>
                    <strong>{test.id}</strong>
                  </td>
                  <td>{test.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{test.sample_type || 'Unspecified'}</td>
                  <td style={{ color: 'var(--ok)', fontWeight: 600 }}>{Number(test.price).toFixed(2)} EGP</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: '6px 12px', fontSize: 12, border: '1px solid var(--border)' }}
                      onClick={() => setParamsModal({ open: true, testId: test.id, testName: test.name })}
                    >
                      {t('actions.parameters', 'Parameters')}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: '6px 12px', fontSize: 12, border: '1px solid var(--border)' }}
                      onClick={() => openEditModal(test)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div id="test-modal" className="modal" style={{ display: modal.open ? 'block' : 'none' }}>
        <div className="modal-content glass-panel" style={{ maxWidth: 450 }}>
          <span className="close" onClick={closeModal}>
            &times;
          </span>
          <h2 style={{ marginBottom: 20, color: 'var(--text)' }}>
            {modal.editingId ? t('modals.edit_test', 'Edit Test') : t('modals.add_test', 'Add New Test')}
          </h2>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
                {t('forms.test_name', 'Test Name')}
              </label>
              <input
                type="text"
                required
                style={{ width: '100%', marginTop: 5 }}
                value={modal.name}
                onChange={(e) => setModal((m) => ({ ...m, name: e.target.value }))}
              />
            </div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
                {t('forms.sample_type', 'Sample Type')}
              </label>
              <input
                type="text"
                placeholder="e.g. Serum, EDTA Blood..."
                required
                style={{ width: '100%', marginTop: 5 }}
                value={modal.sampleType}
                onChange={(e) => setModal((m) => ({ ...m, sampleType: e.target.value }))}
              />
            </div>
            <div style={{ marginBottom: 25 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
                {t('forms.price', 'Price (EGP)')}
              </label>
              <input
                type="number"
                step="0.01"
                required
                style={{ width: '100%', marginTop: 5 }}
                value={modal.price}
                onChange={(e) => setModal((m) => ({ ...m, price: e.target.value }))}
              />
            </div>
            <div style={{ textAlign: 'right' }}>
              <button type="button" className="btn ghost" onClick={closeModal}>
                {t('actions.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn" style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }}>
                {t('actions.save_test', 'Save Test')}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div id="panels-modal" className="modal" style={{ display: panelsModalOpen ? 'block' : 'none' }}>
        <div className="modal-content glass-panel" style={{ maxWidth: 700 }}>
          <span className="close" onClick={closePanelsModal}>
            &times;
          </span>
          <h2 style={{ marginBottom: 5, color: 'var(--text)' }}>Test Panels</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
            Bundle tests that are commonly ordered together (e.g. "Lipid Profile") for quick-select while booking.
            Purely a shortcut — the technician can still add/remove individual tests afterward.
          </p>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <h4 style={{ color: 'var(--muted)', marginBottom: 8, fontSize: 12, textTransform: 'uppercase' }}>Existing Panels</h4>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {panels.length === 0 ? (
                  <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {t('alerts.empty_no_panels', 'No panels yet — create one on the right.')}
                  </p>
                ) : (
                  panels.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 8,
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                      }}
                    >
                      <span>
                        {p.name} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({p.tests.length} tests)</span>
                      </span>
                      <div>
                        <span style={{ cursor: 'pointer', marginRight: 10 }} onClick={() => editPanelForm(p)} title="Edit">
                          ✏️
                        </span>
                        <span style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => handleDeletePanel(p.id)} title="Delete">
                          🗑️
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <button type="button" className="btn ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => setPanelForm(NEW_PANEL_FORM)}>
                + New Panel
              </button>
            </div>
            <div style={{ flex: 1.4, minWidth: 260, background: 'rgba(0,0,0,0.2)', padding: 15, borderRadius: 8 }}>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
                Panel Name
              </label>
              <input
                type="text"
                placeholder="e.g. Lipid Profile"
                style={{ width: '100%', marginBottom: 15 }}
                value={panelForm.name}
                onChange={(e) => setPanelForm((f) => ({ ...f, name: e.target.value }))}
              />

              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
                Member Tests
              </label>
              <div
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 6,
                  background: 'rgba(0,0,0,0.2)',
                  padding: 10,
                  borderRadius: 6,
                }}
              >
                {tests.map((test) => (
                  <label key={test.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={panelForm.selectedTestIds.has(test.id)}
                      onChange={(e) => togglePanelTestId(test.id, e.target.checked)}
                    />
                    {test.name}
                  </label>
                ))}
              </div>

              <div style={{ textAlign: 'right', marginTop: 15 }}>
                <button type="button" className="btn" style={{ background: 'var(--teal)', color: '#04121d' }} onClick={handleSavePanel}>
                  Save Panel
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ParametersModal
        open={paramsModal.open}
        testId={paramsModal.testId}
        testName={paramsModal.testName}
        onClose={() => setParamsModal({ open: false, testId: null, testName: '' })}
      />
    </>
  );
}
