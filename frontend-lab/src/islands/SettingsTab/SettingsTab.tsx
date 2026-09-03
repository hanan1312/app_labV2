import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';
import { useCurrentUser } from '../../lib/useCurrentUser';

interface LabSettings {
  lab_name: string;
  lab_subtitle: string;
  msg_enabled: boolean;
  msg_method: string;
  msg_phone: string;
  require_results_approval: boolean;
  logo_path: string;
  cover_path: string;
  signature_path: string;
  signature_title: string;
  show_report_background: boolean;
  show_logo_on_report: boolean;
  lab_director: string;
  doctor_qualification: string;
  doctor_reg_no: string;
  tech_name: string;
  tech_qualification: string;
  tech_institute: string;
  lab_phone: string;
  lab_email: string;
  lab_address: string;
  social_facebook: string;
  social_instagram: string;
  social_twitter: string;
  report_footer_note: string;
}

const EMPTY_SETTINGS: LabSettings = {
  lab_name: '',
  lab_subtitle: '',
  msg_enabled: false,
  msg_method: 'whatsapp',
  msg_phone: '',
  require_results_approval: false,
  logo_path: 'https://via.placeholder.com/100?text=Lab+Logo',
  cover_path:
    'https://images.unsplash.com/photo-1579154204601-01588f351e67?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80',
  signature_path: 'https://via.placeholder.com/150x60?text=Signature',
  signature_title: '',
  show_report_background: true,
  show_logo_on_report: true,
  lab_director: '',
  doctor_qualification: '',
  doctor_reg_no: '',
  tech_name: '',
  tech_qualification: '',
  tech_institute: '',
  lab_phone: '',
  lab_email: '',
  lab_address: '',
  social_facebook: '',
  social_instagram: '',
  social_twitter: '',
  report_footer_note: '',
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const textInputStyle = {
  width: '100%',
  padding: '10px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(0,0,0,0.3)',
  color: 'white',
};

const fieldLabelStyle = {
  fontWeight: 'bold' as const,
  marginBottom: 5,
  display: 'block',
  color: 'var(--muted)',
  fontSize: 12,
};

const panelStyle = {
  marginBottom: 30,
  background: 'rgba(0,0,0,0.2)',
  padding: 20,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.05)',
};

// One row per settings.report_branding field -> its LabSettings key, matches the fixed
// 2-column grid in index_lab.html's original markup (script_lab.js's reportBrandingFields
// map did the same job for the vanilla version).
const REPORT_BRANDING_FIELDS: Array<{ key: keyof LabSettings; labelKey: string; fallback: string; type?: string }> = [
  { key: 'lab_director', labelKey: 'settings.doctor_name', fallback: 'Doctor Name' },
  { key: 'doctor_qualification', labelKey: 'settings.doctor_qualification', fallback: 'Doctor Qualification' },
  { key: 'doctor_reg_no', labelKey: 'settings.doctor_reg_no', fallback: 'Doctor Reg. No.' },
  { key: 'tech_name', labelKey: 'settings.tech_name', fallback: 'Lab Technician Name' },
  { key: 'tech_qualification', labelKey: 'settings.tech_qualification', fallback: 'Technician Qualification' },
  { key: 'tech_institute', labelKey: 'settings.tech_institute', fallback: 'Technician Institute' },
  { key: 'lab_phone', labelKey: 'settings.lab_phone', fallback: 'Lab Phone', type: 'tel' },
  { key: 'lab_email', labelKey: 'settings.lab_email', fallback: 'Lab Email', type: 'email' },
];

export default function SettingsTab() {
  const { t } = useTranslations();
  const { user } = useCurrentUser();
  const canEdit = !user || user.role === 'admin' || user.permissions.includes('settings');

  const [settings, setSettings] = useState<LabSettings>(EMPTY_SETTINGS);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [coverFilename, setCoverFilename] = useState('');

  useEffect(() => {
    apiFetch('/api/lab/settings')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch settings');
        return res.json();
      })
      .then((data: Partial<LabSettings>) => {
        setSettings((prev) => ({ ...prev, ...data }));
      })
      .catch(() => setLoadError(true));
  }, []);

  function setField<K extends keyof LabSettings>(key: K, value: LabSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleImagePicked(key: 'logo_path' | 'cover_path' | 'signature_path', e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setField(key, dataUrl);
    if (key === 'cover_path') setCoverFilename(file.name);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/lab/settings', { method: 'POST', body: JSON.stringify(settings) });
      if (res.ok) {
        window.showAlert(t('alerts.settings_saved_server', 'Settings saved to server!'), 'success');
        // Refreshes sidebar logo/name, page background, and theme app-wide — still vanilla,
        // cross-cutting beyond this tab (see globals.d.ts).
        await window.applyGlobalSettings();
      } else {
        window.showAlert(t('alerts.settings_save_failed', 'Failed to save settings.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.server_connect_error', 'Error connecting to server.'), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p style={{ color: 'var(--warn)', padding: 20 }}>Could not connect to database.</p>;
  }

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <h1>{t('settings.title', 'System Settings')}</h1>
        <p style={{ color: 'var(--muted)' }}>
          {t('settings.subtitle', 'Manage laboratory branding and visual interface')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="settings-panel">
        <div style={{ padding: 20 }}>
          <div className="setting-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span>{t('settings.theme_mode', 'Theme Mode')}</span>
            <button type="button" className="btn" onClick={() => window.toggleTheme()}>
              {t('settings.toggle_theme', 'Toggle Light/Dark')}
            </button>
          </div>

          <div style={panelStyle}>
            <h3 style={{ color: 'var(--text)', marginBottom: 15 }}>{t('settings.messaging_settings', 'Messaging Settings')}</h3>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={settings.msg_enabled}
                  onChange={(e) => setField('msg_enabled', e.target.checked)}
                  style={{ marginRight: 10, width: 16, height: 16 }}
                />
                {t('settings.enable_notifications', 'Enable Automatic Notifications')}
              </label>
              {settings.msg_enabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
                    {t('settings.method_label', 'Method:')}
                  </label>
                  <select
                    value={settings.msg_method}
                    onChange={(e) => setField('msg_method', e.target.value)}
                    style={{ padding: '6px 12px', borderRadius: 4, background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="sms">Direct SMS</option>
                  </select>
                </div>
              )}
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={fieldLabelStyle}>{t('settings.lab_phone_sender', 'Lab Phone Number (Sender)')}</label>
              <input
                type="tel"
                style={textInputStyle}
                placeholder="e.g. +201000000000"
                value={settings.msg_phone}
                onChange={(e) => setField('msg_phone', e.target.value)}
              />
            </div>

            <div style={{ marginTop: 15, paddingTop: 15, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={settings.require_results_approval}
                  onChange={(e) => setField('require_results_approval', e.target.checked)}
                  style={{ marginRight: 10, width: 16, height: 16 }}
                />
                <span>{t('settings.require_results_approval', 'Require manual approval before sending results')}</span>
              </label>
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={{ color: 'var(--text)', marginBottom: 15 }}>{t('settings.lab_identity', 'Lab Identity')}</h3>
            <label style={fieldLabelStyle}>{t('settings.lab_name', 'Lab Name')}</label>
            <input
              type="text"
              style={{ ...textInputStyle, marginBottom: 15 }}
              placeholder="e.g. Helix Lab"
              value={settings.lab_name}
              onChange={(e) => setField('lab_name', e.target.value)}
            />
            <label style={fieldLabelStyle}>{t('settings.lab_subtitle', 'Lab Subtitle')}</label>
            <input
              type="text"
              style={textInputStyle}
              placeholder="e.g. Diagnostics OS"
              value={settings.lab_subtitle}
              onChange={(e) => setField('lab_subtitle', e.target.value)}
            />
          </div>

          <div style={panelStyle}>
            <h3 style={{ color: 'var(--text)', marginBottom: 15 }}>{t('settings.report_branding', 'Report Branding')}</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 15 }}>
              {t('settings.report_branding_hint', 'Shown on the header/footer of generated lab reports.')}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
              {REPORT_BRANDING_FIELDS.map(({ key, labelKey, fallback, type }, idx) => (
                <>
                  <div key={key}>
                    <label style={fieldLabelStyle}>{t(labelKey, fallback)}</label>
                    <input
                      type={type || 'text'}
                      style={textInputStyle}
                      value={settings[key] as string}
                      onChange={(e) => setField(key, e.target.value as LabSettings[typeof key])}
                    />
                  </div>
                  {/* Empty spacer cells after doctor_reg_no (idx 2) and tech_institute (idx 5),
                      matching index_lab.html's original 2-column grid grouping. */}
                  {(idx === 2 || idx === 5) && <div key={`${key}-spacer`} />}
                </>
              ))}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={fieldLabelStyle}>{t('settings.lab_address', 'Lab Address')}</label>
                <input
                  type="text"
                  style={textInputStyle}
                  placeholder="e.g. 123 Street, City"
                  value={settings.lab_address}
                  onChange={(e) => setField('lab_address', e.target.value)}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('settings.social_facebook', 'Facebook')}</label>
                <input
                  type="text"
                  style={textInputStyle}
                  placeholder="facebook.com/yourlab"
                  value={settings.social_facebook}
                  onChange={(e) => setField('social_facebook', e.target.value)}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('settings.social_instagram', 'Instagram')}</label>
                <input
                  type="text"
                  style={textInputStyle}
                  placeholder="instagram.com/yourlab"
                  value={settings.social_instagram}
                  onChange={(e) => setField('social_instagram', e.target.value)}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('settings.social_twitter', 'Twitter / X')}</label>
                <input
                  type="text"
                  style={textInputStyle}
                  placeholder="x.com/yourlab"
                  value={settings.social_twitter}
                  onChange={(e) => setField('social_twitter', e.target.value)}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={fieldLabelStyle}>{t('settings.report_footer_note', 'Report Footer Note')}</label>
                <textarea
                  rows={2}
                  style={{ ...textInputStyle, resize: 'vertical' }}
                  placeholder="e.g. This report is not valid for medical legal purpose."
                  value={settings.report_footer_note}
                  onChange={(e) => setField('report_footer_note', e.target.value)}
                />
              </div>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginBottom: 40, marginTop: 10 }}>
            <div className="logo-preview-wrapper">
              <img src={settings.logo_path} alt="Lab Logo" />
            </div>
            <label className="btn ghost" style={{ cursor: 'pointer', marginTop: 10, fontSize: 12, padding: '6px 12px' }}>
              {t('settings.change_logo', 'Change Logo')}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleImagePicked('logo_path', e)} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10, fontSize: 13, color: 'var(--ok)', fontWeight: 600, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.show_logo_on_report}
                onChange={(e) => setField('show_logo_on_report', e.target.checked)}
                style={{ width: 'auto', flex: 'none', padding: 0, margin: 0 }}
              />
              <span>{t('settings.show_logo_on_report', 'Show this logo on generated reports')}</span>
            </label>
          </div>

          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <div className="logo-preview-wrapper">
              <img src={settings.signature_path} alt="Pathologist Signature" />
            </div>
            <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>
              {t('settings.signature_shown_note', 'Shown at the bottom-left of every generated report.')}
            </p>
            <label className="btn ghost" style={{ cursor: 'pointer', marginTop: 10, fontSize: 12, padding: '6px 12px' }}>
              {t('settings.change_signature', 'Change Signature')}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleImagePicked('signature_path', e)} />
            </label>
            <div style={{ maxWidth: 280, margin: '12px auto 0' }}>
              <label style={fieldLabelStyle}>{t('settings.signature_title', 'Signature Title')}</label>
              <input
                type="text"
                style={textInputStyle}
                placeholder="e.g. Consultant Pathologist"
                value={settings.signature_title}
                onChange={(e) => setField('signature_title', e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginBottom: 0 }}>
            <label style={{ fontWeight: 'bold', marginBottom: 10, display: 'block', color: 'var(--text)' }}>
              {t('settings.cover', 'Cover')}
            </label>
            <div className="custom-file-input-group">
              <input type="text" readOnly placeholder={t('settings.choose_file', 'Choose file')} value={coverFilename} />
              <label className="browse-btn">
                {t('settings.browse', 'Browse')}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleImagePicked('cover_path', e)} />
              </label>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--ok)', fontWeight: 600, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.show_report_background}
                onChange={(e) => setField('show_report_background', e.target.checked)}
                style={{ width: 'auto', flex: 'none', padding: 0, margin: 0 }}
              />
              <span>{t('settings.show_report_background', 'Show this cover as a background on generated reports')}</span>
            </label>
          </div>
        </div>

        <div className="cover-image-container">
          <img src={settings.cover_path} alt="Cover Preview" />
        </div>

        <div className="settings-footer">
          {!canEdit && (
            <p style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 8 }}>
              {t('settings.no_settings_permission', 'You do not have permission to change settings.')}
            </p>
          )}
          <button
            type="submit"
            className="btn"
            disabled={!canEdit || saving}
            style={{ background: '#007bff', color: 'white', border: 'none', padding: '8px 24px', borderRadius: 4, fontSize: 14, opacity: !canEdit || saving ? 0.6 : 1 }}
          >
            {t('actions.update', 'Update')}
          </button>
        </div>
      </form>
    </>
  );
}
