// Generic "what's behind this number" drill-down — every clickable row in DayCloseTab (a
// test name, a physician, a gender count, a result status) opens one of these instead of its
// own bespoke modal, since they're all really the same shape: a title plus a filtered slice
// of the day's already-fetched visits_detail/results_detail rows.
interface Props {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
  emptyText: string;
  onClose: () => void;
}

export default function DetailModal({ title, columns, rows, emptyText, onClose }: Props) {
  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-content glass-panel" style={{ maxWidth: 640 }}>
        <span className="close" onClick={onClose}>
          &times;
        </span>
        <h2 style={{ marginBottom: 15, color: 'var(--text)' }}>{title}</h2>
        {rows.length === 0 ? (
          <div style={{ color: 'var(--muted)', padding: '10px 0' }}>{emptyText}</div>
        ) : (
          <div className="table-container" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="admin-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key}>{row[c.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
