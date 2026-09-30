import { drawQr, QUIET_ZONE, qrMatrix } from './qr-canvas';

/** A 2D context that only records `fillRect` calls (jsdom has no canvas). */
function recordingContext() {
  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  const context = {
    fillStyle: '',
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(this.fillStyle) });
    },
  };
  return { rects, context: context as unknown as CanvasRenderingContext2D };
}

describe('QR drawing', () => {
  // The URL the kiosk encodes: WEB_BASE_URL + /punch# + a 71-character token (ADR 009 §2).
  const url = `https://pointage.groupe-exemple.dz/punch#${'A'.repeat(71)}`; // 112 characters

  it('encodes a ~110-character punch URL as version 7 (45 × 45 modules) at error correction M', () => {
    expect(url).toHaveLength(112);
    expect(qrMatrix(url).size).toBe(45);
    expect(qrMatrix('https://x.dz/punch#abc').size).toBe(25); // version 2: the size follows the data
  });

  it('paints a white square then whole-pixel black modules inside a 4-module quiet zone', () => {
    const matrix = qrMatrix(url);
    const { rects, context } = recordingContext();
    drawQr(context, matrix, 530);
    const cell = Math.floor(530 / (matrix.size + 2 * QUIET_ZONE)); // 10 px per module
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 530, h: 530, fill: '#ffffff' });
    const modules = rects.slice(1);
    expect(modules.every((r) => r.fill === '#000000' && r.w === cell && r.h === cell)).toBe(true);
    const margin = Math.floor((530 - cell * matrix.size) / 2);
    expect(margin).toBeGreaterThanOrEqual(QUIET_ZONE * cell);
    // The top-left finder pattern starts at the first module.
    expect(modules[0]).toMatchObject({ x: margin, y: margin });
  });
});
