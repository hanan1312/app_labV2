import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

interface ClientFormFields {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  contact_person: string;
  phone: string;
  client_phone: string;
  blood_type: string;
  city: string;
  area: string;
  street: string;
  apartment: string;
  allergies: string;
  clinical_indications: string;
}

const EMPTY_FORM: ClientFormFields = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  gender: '',
  contact_person: '',
  phone: '',
  client_phone: '',
  blood_type: '',
  city: '',
  area: '',
  street: '',
  apartment: '',
  allergies: '',
  clinical_indications: '',
};

const BLOOD_TYPES = ['A+', 'O+', 'B+', 'AB+', 'A-', 'O-', 'B-', 'AB-'];

// Coordinates with ClientsTab (and the still-vanilla quickEditPatient(), called from Tech
// Screen/Pending Samples row actions and DashboardTab's bridge) via the 'lab:edit-client'
// CustomEvent instead of the old direct DOM writes into #client-form — same bridge pattern
// as lab:refresh-dashboard/lab:refresh-statistics. quickEditPatient(clientId) now just
// dispatches this event + calls showTab('add-client'); ClientsTab's own "Add New Patient"
// button dispatches { clientId: null } directly for the same reason.
export default function AddClientTab() {
  const { t } = useTranslations();

  const [fields, setFields] = useState<ClientFormFields>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const editingIdRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    editingIdRef.current = editingId;
  }, [editingId]);

  useEffect(() => {
    const onEditClient = async (e: Event) => {
      const clientId = (e as CustomEvent<{ clientId: number | null }>).detail?.clientId ?? null;
      setErrors([]);
      if (clientId == null) {
        setEditingId(null);
        setFields(EMPTY_FORM);
        return;
      }
      try {
        const res = await apiFetch(`/api/clients/${clientId}`);
        if (!res.ok) throw new Error('Failed to load client');
        const client = await res.json();
        setEditingId(client.id);
        setFields({
          first_name: client.first_name || '',
          last_name: client.last_name || '',
          date_of_birth: client.date_of_birth || '',
          gender: client.gender || '',
          contact_person: client.contact_person || '',
          phone: client.phone || '',
          client_phone: client.client_phone || '',
          blood_type: client.blood_type || '',
          city: client.city || '',
          area: client.area || '',
          street: client.street || '',
          apartment: client.apartment || '',
          allergies: client.allergies || '',
          clinical_indications: client.clinical_indications || '',
        });
      } catch {
        window.showAlert(t('alerts.client_not_found', 'Client not found'), 'error');
      }
    };
    window.addEventListener('lab:edit-client', onEditClient);
    return () => window.removeEventListener('lab:edit-client', onEditClient);
  }, [t]);

  // A genuine direct click on the sidebar's own "Add Patient" button (not preceded by a
  // lab:edit-client dispatch) only resets the form when there wasn't already an edit in
  // progress — matches showTab()'s old `case 'add-client': if (!editingClientId)
  // resetClientForm();` guard, which preserved an in-progress edit if the user navigated
  // away and back rather than silently discarding it.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="add-client"]');
    const onTabClick = () => {
      if (editingIdRef.current == null) {
        setFields(EMPTY_FORM);
        setErrors([]);
      }
    };
    tabButton?.addEventListener('click', onTabClick);
    return () => tabButton?.removeEventListener('click', onTabClick);
  }, []);

  function setField<K extends keyof ClientFormFields>(key: K, value: ClientFormFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const endpoint = editingId ? `/api/clients/${editingId}` : '/api/clients';
      const method = editingId ? 'PUT' : 'POST';
      const res = await apiFetch(endpoint, { method, body: JSON.stringify(fields) });
      if (res.ok) {
        window.showAlert(editingId ? t('alerts.client_updated', 'Client updated successfully!') : t('alerts.client_added', 'Client added successfully!'), 'success');
        // Keeps the vanilla `clients`/`allVisits` globals in sync for still-vanilla
        // consumers (Excel import's duplicate check, Tech Screen, Pending Samples) — its own
        // refreshVisibleTables() call at the end fires 'lab:refresh-clients', which
        // ClientsTab listens for to refetch itself (see that component).
        await window.loadInitialData();
        setEditingId(null);
        setFields(EMPTY_FORM);
        window.showTab('clients');
      } else {
        const body = await res.json().catch(() => ({}));
        const messages: string[] = body.errors || (body.error ? [body.error] : [t('alerts.client_save_failed', 'Failed to save client')]);
        setErrors(messages);
      }
    } catch (err) {
      setErrors([t('alerts.client_save_error', 'Error saving client: {msg}', { msg: (err as Error).message })]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>{t('add_patient.title', 'Register Patient')}</h1>
      <div className="card">
        <form id="client-form" onSubmit={handleSubmit}>
          {errors.length > 0 && (
            <div style={{ color: 'var(--danger)', marginBottom: 15, fontSize: 13 }}>
              {errors.map((msg) => (
                <div key={msg}>{msg}</div>
              ))}
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.first_name', 'First Name *')}</label>
              <input type="text" required value={fields.first_name} onChange={(e) => setField('first_name', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.last_name', 'Last Name *')}</label>
              <input type="text" required value={fields.last_name} onChange={(e) => setField('last_name', e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.dob', 'Date of Birth *')}</label>
              <input type="date" required value={fields.date_of_birth} onChange={(e) => setField('date_of_birth', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.gender', 'Gender *')}</label>
              <select required value={fields.gender} onChange={(e) => setField('gender', e.target.value)}>
                <option value="">{t('forms.select', 'Select')}</option>
                <option value="Male">{t('filters.male', 'Male')}</option>
                <option value="Female">{t('filters.female', 'Female')}</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.contact_person', 'Contact Person *')}</label>
              <input type="text" required value={fields.contact_person} onChange={(e) => setField('contact_person', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.phone', 'Phone *')}</label>
              <input type="tel" required value={fields.phone} onChange={(e) => setField('phone', e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.client_phone', 'Client Phone')}</label>
              <input type="tel" value={fields.client_phone} onChange={(e) => setField('client_phone', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.blood_type', 'Blood Type')}</label>
              <select value={fields.blood_type} onChange={(e) => setField('blood_type', e.target.value)}>
                <option value="">{t('forms.select', 'Select')}</option>
                {BLOOD_TYPES.map((bt) => (
                  <option key={bt} value={bt}>
                    {bt}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.city', 'City')}</label>
              <input type="text" value={fields.city} onChange={(e) => setField('city', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.area', 'Area')}</label>
              <input type="text" value={fields.area} onChange={(e) => setField('area', e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>{t('forms.street', 'Street')}</label>
              <input type="text" value={fields.street} onChange={(e) => setField('street', e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('forms.apartment', 'Apartment')}</label>
              <input type="text" value={fields.apartment} onChange={(e) => setField('apartment', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>{t('forms.allergies', 'Allergies')}</label>
            <textarea rows={2} value={fields.allergies} onChange={(e) => setField('allergies', e.target.value)} />
          </div>
          <div className="form-group">
            <label>{t('forms.clinical_indications', 'Clinical Indications')}</label>
            <textarea rows={3} value={fields.clinical_indications} onChange={(e) => setField('clinical_indications', e.target.value)} />
          </div>
          {/* Neither label was ever wrapped in t()/data-i18n in the original
              (resetClientForm()/quickEditPatient() set this textContent directly) — kept
              literal here for a faithful port rather than introducing translation coverage
              that didn't exist before. */}
          <button type="submit" className={editingId ? 'btn btn-success' : 'btn btn-primary'} disabled={saving}>
            {editingId ? '💾 Save Changes' : 'Add Client'}
          </button>
        </form>
      </div>
    </>
  );
}
