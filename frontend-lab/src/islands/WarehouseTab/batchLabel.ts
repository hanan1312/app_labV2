import { openPrintWindow } from './printWindow';

// TS port of script_lab.js's generateBarcodeImage()/printBatchBarcode() — kept warehouse-batch
// specific rather than added to globals.d.ts as a shared bridge, since the vanilla
// generateBarcodeImage() is also still used by other still-vanilla barcode features (sample
// tube stickers) that have nothing to do with this slice.
export function batchBarcodeImage(barcode: string): string {
  const canvas = document.createElement('canvas');
  window.JsBarcode(canvas, barcode, { width: 1.5, height: 35, displayValue: true, fontSize: 14, margin: 0 });
  return canvas.toDataURL('image/png');
}

export function printBatchLabel(barcode: string, itemName: string, expiryDate: string) {
  openPrintWindow(
    `Batch Label — ${itemName}`,
    `<div style="text-align:center;"><h3>${itemName}</h3><p>Expiry: <strong>${expiryDate}</strong></p><img src="${batchBarcodeImage(barcode)}" style="margin-top:15px;"></div>`,
    500,
    400
  );
}
