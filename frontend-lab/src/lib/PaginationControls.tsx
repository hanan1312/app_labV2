// React port of script_lab.js's renderPaginationControls (script_lab.js:192-224) — same
// prev/next + up-to-7-numbered-buttons-with-ellipsis layout and "Page X of Y (N total)"
// label (neither translated in the original either), but takes a callback instead of the
// name of a global function to call by string.
import type { ReactNode } from 'react';

interface PaginationState {
  page: number;
  total_pages: number;
  total: number;
}

export function PaginationControls({
  state,
  onPageChange,
}: {
  state: PaginationState;
  onPageChange: (page: number) => void;
}) {
  const page = state.page || 1;
  const totalPages = state.total_pages || 1;
  if (totalPages <= 1) return null;

  const maxButtons = 7;
  let pages: number[];
  if (totalPages <= maxButtons) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    const keep = new Set(
      [1, totalPages, page, page - 1, page + 1].filter((p) => p >= 1 && p <= totalPages)
    );
    pages = [...keep].sort((a, b) => a - b);
  }

  const buttons: ReactNode[] = [];
  let lastPage = 0;
  pages.forEach((p) => {
    if (p - lastPage > 1) {
      buttons.push(
        <span key={`ellipsis-${p}`} style={{ padding: '0 4px', color: 'var(--muted)' }}>
          &hellip;
        </span>
      );
    }
    buttons.push(
      <button
        key={p}
        className={`btn ${p === page ? '' : 'ghost'}`}
        style={{ padding: '6px 12px', minWidth: 38 }}
        onClick={() => onPageChange(p)}
      >
        {p}
      </button>
    );
    lastPage = p;
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 15, flexWrap: 'wrap' }}>
      <button
        className="btn ghost"
        style={{ padding: '6px 12px' }}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        &larr; Prev
      </button>
      {buttons}
      <button
        className="btn ghost"
        style={{ padding: '6px 12px' }}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        Next &rarr;
      </button>
      <span style={{ marginLeft: 10, color: 'var(--muted)', fontSize: 12 }}>
        Page {page} of {totalPages} ({state.total} total)
      </span>
    </div>
  );
}
