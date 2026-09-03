// Shared "open a blank window, write a print-styled document, auto-print+close" helper —
// every warehouse print flow (bill receipt, bulk bill) in the vanilla version built this same
// shell by hand per call site; factored out here since it's now used by more than one modal.
export function openPrintWindow(title: string, bodyHtml: string, width = 600, height = 600) {
  const printWindow = window.open('', '_blank', `width=${width},height=${height}`);
  if (!printWindow) return;
  printWindow.document.write(`
        <html><head><title>${title}</title><style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
            th { background: #f4f4f4; }
        </style></head><body>
            ${bodyHtml}
            <script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},200)}</script>
        </body></html>
    `);
  printWindow.document.close();
}
