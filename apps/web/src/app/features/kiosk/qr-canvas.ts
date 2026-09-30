/**
 * `<app-qr-canvas [text]="url" />` — draws a QR code on a `<canvas>`: black modules on white, a 4-module quiet zone,
 * error correction M (ADR 009: the URL is ~110 characters → version 7, 45 × 45 modules). Used by the kiosk only.
 *
 * Why a canvas: the CSP allows `img-src 'self' data:`, so a data-URL `<img>` would work too, but a canvas needs no
 * encoding round trip (PNG → base64 → decode) every 30 s on a cheap tablet, and draws crisp squares at any size.
 * The encoder is `qrcode-generator` (MIT, plain JS: no `eval`, no WebAssembly — the CSP has neither), bundled by the
 * Angular build into the kiosk's lazy chunk only.
 *
 * Angular concepts:
 * - **`viewChild.required('canvas')`** — a SIGNAL query for the `<canvas #canvas>` of the template. Reading it gives
 *   the `ElementRef`; because it is a signal, code that reads it re-runs if the element were replaced.
 * - **`afterRenderEffect()` for drawing.** Drawing needs the element to EXIST and to have its CSS size (the pixel
 *   size is computed from `clientWidth`). A plain `effect()` may run before Angular has created or laid out the
 *   element; `afterRenderEffect` runs after the DOM is written, and — like `effect()` — re-runs only when a signal it
 *   reads changes: here `text()` (a new window every 30 s) and `size()` (a window resize). Between those, the canvas
 *   keeps its pixels: nothing is redrawn on the kiosk's per-second clock ticks.
 * - **`host: { '(window:resize)': … }`** — a host listener on a GLOBAL target (`window:`, `document:`), removed by
 *   Angular with the component. It only bumps a signal; the effect above does the drawing.
 * - **`role="img"` + `aria-label`** on the canvas: a canvas has no text for assistive tech; the label says what it is
 *   (the instruction next to it says what to do).
 */
import { afterRenderEffect, ChangeDetectionStrategy, Component, type ElementRef, input, signal, viewChild } from '@angular/core';
import qrcodeFactory from 'qrcode-generator';

/** Modules of white border on each side (the QR specification's minimum quiet zone). */
export const QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, WITHOUT the quiet zone. */
  readonly size: number;
  readonly isDark: (row: number, col: number) => boolean;
}

/** Encodes `text` (byte mode, error correction M, smallest version that fits). */
export function qrMatrix(text: string): QrMatrix {
  const code = qrcodeFactory(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  return { size: code.getModuleCount(), isDark: (row, col) => code.isDark(row, col) };
}

/**
 * Paints the matrix on a 2D context of `pixels` × `pixels`. Each module is a whole number of device pixels (sharp
 * edges); the leftover pixels are split around the code, inside the white quiet zone.
 */
export function drawQr(context: CanvasRenderingContext2D, matrix: QrMatrix, pixels: number): void {
  const modules = matrix.size + 2 * QUIET_ZONE;
  const cell = Math.max(1, Math.floor(pixels / modules));
  const margin = Math.floor((pixels - cell * matrix.size) / 2);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = '#000000';
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.isDark(row, col)) context.fillRect(margin + col * cell, margin + row * cell, cell, cell);
    }
  }
}

@Component({
  selector: 'app-qr-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resized.update((n) => n + 1)' },
  template: `<canvas #canvas role="img" [attr.aria-label]="label()"></canvas>`,
  styles: `
    :host { display: block; }
    canvas { display: block; inline-size: 100%; block-size: auto; aspect-ratio: 1; background: #fff; }
  `,
})
export class QrCanvas {
  /** The text to encode (the punch URL). */
  readonly text = input.required<string>();
  /** Accessible name of the image. */
  readonly label = input('');

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly resized = signal(0);

  constructor() {
    afterRenderEffect(() => {
      this.resized();
      const text = this.text();
      const element = this.canvas().nativeElement;
      const ratio = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
      const pixels = Math.max(1, Math.round((element.clientWidth || 300) * ratio));
      element.width = pixels;
      element.height = pixels;
      const context = element.getContext('2d');
      if (!context) return;
      drawQr(context, qrMatrix(text), pixels);
    });
  }
}
