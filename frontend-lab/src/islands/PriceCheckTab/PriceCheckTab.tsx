import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

interface LabTest {
  name: string;
  sample_type?: string;
  price: number;
}

// Ported 1:1 from index_lab.html's #price-check-discount options (script_lab.js:5322-5334
// computes the same subtotal/discount/total math against these same percentages).
const DISCOUNT_OPTIONS = [0, 10, 15, 20, 25, 30, 50];

export default function PriceCheckTab() {
  const { t } = useTranslations();
  const [tests, setTests] = useState<LabTest[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  // test name -> price. Kept as the source of truth (not derived from checkbox DOM state)
  // so a selected test doesn't drop out of the total just because a search term temporarily
  // hides it from the list — same rationale as priceCheckSelectedTests in the original.
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [discount, setDiscount] = useState(0);

  useEffect(() => {
    apiFetch('/api/tests')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch tests');
        return res.json() as Promise<LabTest[]>;
      })
      .then(setTests)
      .catch(() => setLoadError(true));
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return tests;
    return tests.filter(
      (test) =>
        test.name.toLowerCase().includes(term) ||
        (test.sample_type || '').toLowerCase().includes(term)
    );
  }, [tests, search]);

  function toggleTest(test: LabTest, checked: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) next[test.name] = test.price;
      else delete next[test.name];
      return next;
    });
  }

  function clearSelection() {
    setSelected({});
    setSearch('');
    setDiscount(0);
  }

  const selectedNames = Object.keys(selected);
  const subtotal = selectedNames.reduce((sum, name) => sum + (selected[name] || 0), 0);
  const total = subtotal - (subtotal * discount) / 100;

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <h1>{t('price_check.title', 'Check Tests Total Price')}</h1>
        <p style={{ color: 'var(--muted)' }}>
          {t(
            'price_check.subtitle',
            'Select tests to quote a total price to a patient — nothing is booked or saved.'
          )}
        </p>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div
          style={{ display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap', marginBottom: 15 }}
        >
          <div className="search-box" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <span className="search-icon">⌕</span>
            <input
              type="text"
              placeholder={t('price_check.search_placeholder', 'Search tests by name or sample type...')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="button" className="btn ghost" onClick={clearSelection}>
            🔄 <span>{t('price_check.clear_selection', 'Clear Selection')}</span>
          </button>
        </div>

        <div
          style={{
            maxHeight: 420,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 6,
          }}
        >
          {loadError ? (
            <p style={{ color: 'var(--warn)', padding: 20 }}>Could not connect to database.</p>
          ) : filtered.length === 0 ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>
              {t('alerts.empty_no_tests_available', 'No tests available. Click "Add New Test" to begin.')}
            </p>
          ) : (
            filtered.map((test) => (
              <label
                key={test.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  color: 'var(--text)',
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                <input
                  type="checkbox"
                  className="price-check-checkbox"
                  checked={Object.prototype.hasOwnProperty.call(selected, test.name)}
                  onChange={(e) => toggleTest(test, e.target.checked)}
                  style={{ marginRight: 10, width: 'auto' }}
                />
                <span style={{ flex: 1 }}>
                  {test.name}{' '}
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    ({test.sample_type || 'Unspecified'})
                  </span>
                </span>
                <span style={{ color: 'var(--ok)', fontSize: 12 }}>
                  {Number(test.price).toFixed(2)} EGP
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <div
        className="card"
        style={{
          padding: 20,
          marginTop: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 15,
        }}
      >
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--muted)' }}>
            {t('price_check.tests_selected', 'Tests Selected')}
          </div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: 'var(--text)' }}>
            {selectedNames.length}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--muted)' }}>
            {t('price_check.subtotal', 'Subtotal')}
          </div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: 'var(--text)' }}>
            {subtotal.toFixed(2)} EGP
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              color: 'var(--muted)',
              marginBottom: 6,
              display: 'block',
            }}
          >
            {t('checkout.discount', 'Discount')}
          </label>
          <select value={discount} onChange={(e) => setDiscount(Number(e.target.value))}>
            {DISCOUNT_OPTIONS.map((pct) => (
              <option key={pct} value={pct}>
                {pct === 0 ? t('checkout.discount_none', 'None (0%)') : `${pct}%`}
              </option>
            ))}
          </select>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--muted)' }}>
            {t('price_check.total_price', 'Total Price')}
          </div>
          <div style={{ fontSize: 30, fontWeight: 'bold', color: 'var(--ok)' }}>
            {total.toFixed(2)} EGP
          </div>
        </div>
      </div>
    </>
  );
}
