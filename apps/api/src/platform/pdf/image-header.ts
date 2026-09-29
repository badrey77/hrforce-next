/**
 * Pixel dimensions of a PNG or JPEG read from its header only — the image is never decoded.
 *
 * Why: Typst decodes an embedded image in full before placing it, inside the API process (ADR 008, render threads).
 * A small file can declare a huge canvas (a 246 KB 1-bit PNG of 45 000 × 45 000 px took ~2 GB in a direct Typst
 * render), and a Rust allocation failure aborts the WHOLE process; `worker.terminate()` does not stop native code.
 * So every image handed to Typst must have its dimensions checked first, at upload and again at render time.
 *
 * - PNG: the IHDR chunk right after the 8-byte signature (length 13, then width, height, bit depth, colour type,
 *   compression, filter, interlace); the bit depth / colour type pair must be one the PNG spec allows.
 * - JPEG: markers are scanned from SOI to the first SOFn (C0–C3, C5–C7, C9–CB, CD–CF: baseline, extended,
 *   progressive, lossless, arithmetic); every other segment (APPn/EXIF, DQT, DHT, COM…) is skipped by its length.
 *   Reaching SOS or EOI first, a length running past the end, or a zero height/width is malformed.
 */

/**
 * At most 4 000 px per side and 16 megapixels in total. Decoders expand an image to a pixel buffer of up to 8 bytes a
 * pixel (16-bit RGBA; usually 4, RGBA8), and an engine may hold a couple of copies while converting and compressing it
 * for the PDF: 16 MP × 8 B ≈ 128 MB per copy at worst, which the API can afford for the few seconds of a render.
 * The pixel cap is the memory bound (it holds even if the side limit is raised for long banners); the side limit keeps
 * logos to sane shapes. 4 000 px is already ~34 cm at 300 dpi — far wider than any letterhead.
 */
export const IMAGE_MAX_SIDE = 4000;
export const IMAGE_MAX_PIXELS = 16_000_000;

export type HeaderImageType = 'image/png' | 'image/jpeg';

export type ImageHeader = { ok: true; type: HeaderImageType; width: number; height: number } | { ok: false; reason: 'unsupported' | 'malformed' };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG colour type → allowed bit depths (PNG spec, table 11.1). */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale + alpha
  6: [8, 16], // truecolour + alpha
};

/** PNG width/height are 31-bit (spec: "zero is an invalid value", maximum 2^31 − 1). */
const PNG_MAX_DIMENSION = 0x7fffffff;

function readPng(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // signature (8) + chunk length (4) + "IHDR" (4) + data (13); the CRC is not needed to read the header
  if (bytes.length < 8 + 8 + 13) return { ok: false, reason: 'malformed' };
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (view.getUint32(8) !== 13 || type !== 'IHDR') return { ok: false, reason: 'malformed' };
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = view.getUint8(24);
  const colour = view.getUint8(25);
  const compression = view.getUint8(26);
  const filter = view.getUint8(27);
  const interlace = view.getUint8(28);
  if (width === 0 || height === 0 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) return { ok: false, reason: 'malformed' };
  if (!PNG_DEPTHS[colour]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) return { ok: false, reason: 'malformed' };
  return { ok: true, type: 'image/png', width, height };
}

/** Start-of-frame markers: C0–CF except C4 (DHT), C8 (JPG extension) and CC (DAC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(bytes: Uint8Array): ImageHeader {
  let i = 2; // after SOI (FF D8)
  for (;;) {
    // a marker: 0xFF, optional 0xFF fill bytes, then the marker code
    if (i >= bytes.length || bytes[i] !== 0xff) return { ok: false, reason: 'malformed' };
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) return { ok: false, reason: 'malformed' };
    const marker = bytes[i] as number;
    i += 1;
    // standalone markers carry no length: TEM, RST0–7 (SOI again is malformed)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // image data or end of image before any frame header; 0x00 is a stuffed byte, never a marker here
    if (marker === 0xda || marker === 0xd9 || marker === 0xd8 || marker === 0x00) return { ok: false, reason: 'malformed' };
    if (i + 2 > bytes.length) return { ok: false, reason: 'malformed' };
    const length = ((bytes[i] as number) << 8) | (bytes[i + 1] as number); // includes its own two bytes
    if (length < 2 || i + length > bytes.length) return { ok: false, reason: 'malformed' };
    if (isSof(marker)) {
      // length(2) precision(1) height(2) width(2) components(1), then 3 bytes per component
      if (length < 8) return { ok: false, reason: 'malformed' };
      const height = ((bytes[i + 3] as number) << 8) | (bytes[i + 4] as number);
      const width = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const components = bytes[i + 7] as number;
      // height 0 means "given later by a DNL marker": refuse, the size must be known up front
      if (width === 0 || height === 0 || components === 0 || length !== 8 + 3 * components) return { ok: false, reason: 'malformed' };
      return { ok: true, type: 'image/jpeg', width, height };
    }
    i += length;
  }
}

/** The type and pixel dimensions from the header; `unsupported` when neither PNG nor JPEG, `malformed` when unreadable. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return readPng(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return readJpeg(bytes);
  return { ok: false, reason: 'unsupported' };
}

/** Whether an image of this size may be handed to the PDF engine ({@link IMAGE_MAX_SIDE}, {@link IMAGE_MAX_PIXELS}). */
export function withinImageLimits(size: { width: number; height: number }): boolean {
  return size.width <= IMAGE_MAX_SIDE && size.height <= IMAGE_MAX_SIDE && size.width * size.height <= IMAGE_MAX_PIXELS;
}
