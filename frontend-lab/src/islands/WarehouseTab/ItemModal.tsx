import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

export interface WarehouseItemRow {
  id: number;
  name: string;
  category: string;
  quantity: number;
  critical_level: number;
  unit: string;
  updated_at?: string;
  has_expired_batch: boolean;
}

interface Props {
  editingItem: WarehouseItemRow | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}

export default function ItemModal({ editingItem, categories, onClose, onSaved }: Props) {
  const { t } = useTranslations();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [quantity, setQuantity] = useState('0');
  const [criticalLevel, setCriticalLevel] = useState('5');
  const [unit, setUnit] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingItem) {
      setName(editingItem.name);
      setCategory(editingItem.category);
      setQuantity(String(editingItem.quantity));
      setCriticalLevel(String(editingItem.critical_level || 5));
      setUnit(editingItem.unit);
    } else {
      setName('');
      setCategory('');
      setQuantity('0');
      setCriticalLevel('5');
      setUnit('');
    }
  }, [editingItem]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/warehouse', {
        method: 'POST',
        body: JSON.stringify({
          id: editingItem?.id ?? '',
          name,
          category,
          quantity,
          critical_level: criticalLevel,
          unit,
        }),
      });
      if (res.ok) {
        window.showAlert(t('alerts.warehouse_item_saved', 'Warehouse item saved successfully!'), 'success');
        onSaved();
      } else {
        window.showAlert(t('alerts.warehouse_item_save_failed_console', 'Failed to save item. Check console.'), 'error');
      }
    } catch {
      window.showAlert(t('alerts.warehouse_item_save_failed', 'Failed to save item'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 550 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 20, color: 'var(--text)' }}>{editingItem ? 'Edit Warehouse Item' : 'Add New Item'}</h2>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 15 }}>
            <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Item Name</label>
            <input type="text" required style={{ width: '100%', marginTop: 5 }} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div style={{ marginBottom: 15 }}>
            <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Category</label>
            <input
              type="text"
              list="warehouse-item-modal-category-list"
              required
              placeholder="e.g. Consumables"
              style={{ width: '100%', marginTop: 5 }}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="warehouse-item-modal-category-list">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 25 }}>
            <div>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Quantity</label>
              <input type="number" required min={0} style={{ width: '100%', marginTop: 5 }} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div>
              <label style={{ color: 'var(--danger)', fontSize: 12, textTransform: 'uppercase' }}>Critical Level</label>
              <input
                type="number"
                required
                min={0}
                style={{ width: '100%', marginTop: 5 }}
                value={criticalLevel}
                onChange={(e) => setCriticalLevel(e.target.value)}
              />
            </div>
            <div>
              <label style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>Unit</label>
              <input type="text" required placeholder="e.g. Boxes" style={{ width: '100%', marginTop: 5 }} value={unit} onChange={(e) => setUnit(e.target.value)} />
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" style={{ background: 'var(--teal)', color: '#04121d', marginLeft: 10 }} disabled={saving}>
              Save Item
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
