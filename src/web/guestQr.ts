import { create } from 'qrcode';

export function drawInvoiceQr(canvas: HTMLCanvasElement, invoice: string) {
  const { modules } = create(invoice, { errorCorrectionLevel: 'M' });
  const margin = 4;
  const scale = 8;
  const size = (modules.size + margin * 2) * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('QR rendering is unavailable.');
  canvas.width = canvas.height = size;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000';
  for (let row = 0; row < modules.size; row++) {
    for (let column = 0; column < modules.size; column++) {
      if (modules.get(row, column)) {
        context.fillRect((column + margin) * scale, (row + margin) * scale, scale, scale);
      }
    }
  }
}
