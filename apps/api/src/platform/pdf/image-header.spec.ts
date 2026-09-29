import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, readImageHeader, withinImageLimits } from './image-header.js';
import { unsafeRenderInput, RENDER_INPUT_MAX_BYTES } from './typst-renderer.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC not checked by the reader
}

/** A PNG header (IHDR + a tiny IDAT + IEND): the declared size is never backed by pixels, nothing decodes it here. */
function png(width: number, height: number, depth = 8, colour = 2, extra: { compression?: number; interlace?: number } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(depth, 8);
  ihdr.writeUInt8(colour, 9);
  ihdr.writeUInt8(extra.compression ?? 0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(extra.interlace ?? 0, 12);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))]);
}

/** A JPEG segment: FF, marker, big-endian length (payload + 2), payload. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function sof(marker: number, width: number, height: number, components = 3): Buffer {
  const payload = Buffer.alloc(6 + 3 * components);
  payload.writeUInt8(8, 0); // precision
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload.writeUInt8(components, 5);
  for (let c = 0; c < components; c++) payload.writeUInt8(c + 1, 6 + 3 * c);
  return segment(marker, payload);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const APP0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
const DQT = segment(0xdb, Buffer.alloc(65));
const DHT = segment(0xc4, Buffer.alloc(30));
const SOS = segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));

function jpeg(...parts: Buffer[]): Buffer {
  return Buffer.concat([SOI, ...parts, Buffer.from([0x12, 0x34]), EOI]);
}

describe('readImageHeader', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageHeader(png(160, 48))).toEqual({ ok: true, type: 'image/png', width: 160, height: 48 });
    expect(readImageHeader(png(45_000, 45_000, 1, 0))).toEqual({ ok: true, type: 'image/png', width: 45_000, height: 45_000 });
    expect(readImageHeader(png(10, 10, 4, 3, { interlace: 1 }))).toMatchObject({ ok: true, width: 10, height: 10 });
  });

  it('refuses a PNG with an absurd or truncated IHDR', () => {
    expect(readImageHeader(png(10, 10, 3, 2))).toEqual({ ok: false, reason: 'malformed' }); // RGB is 8 or 16 bits
    expect(readImageHeader(png(10, 10, 16, 3))).toEqual({ ok: false, reason: 'malformed' }); // indexed is ≤ 8 bits
    expect(readImageHeader(png(10, 10, 8, 5))).toEqual({ ok: false, reason: 'malformed' }); // no colour type 5
    expect(readImageHeader(png(10, 10, 8, 2, { compression: 1 }))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(png(10, 10, 8, 2, { interlace: 2 }))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(png(0, 10))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(png(0x80000000, 10))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(png(10, 10).subarray(0, 28))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(SIGNATURE)).toEqual({ ok: false, reason: 'malformed' });
    // the first chunk is not IHDR
    expect(readImageHeader(Buffer.concat([SIGNATURE, chunk('IDAT', Buffer.alloc(13)), chunk('IEND', Buffer.alloc(0))]))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reads a baseline JPEG, a progressive one, and one with EXIF (APP1) before the frame header', () => {
    expect(readImageHeader(jpeg(APP0, DQT, sof(0xc0, 640, 480), DHT, SOS))).toEqual({ ok: true, type: 'image/jpeg', width: 640, height: 480 });
    expect(readImageHeader(jpeg(APP0, DQT, DHT, sof(0xc2, 1024, 768), SOS))).toEqual({ ok: true, type: 'image/jpeg', width: 1024, height: 768 });
    const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(5000, 0xff)])); // FF bytes inside a segment are skipped by length
    expect(readImageHeader(jpeg(exif, DQT, sof(0xc0, 200, 100, 1), SOS))).toEqual({ ok: true, type: 'image/jpeg', width: 200, height: 100 });
    // fill bytes before a marker, a comment, an arithmetic-coded frame
    const filled = Buffer.concat([SOI, Buffer.from([0xff, 0xff]), segment(0xfe, Buffer.from('hi')), sof(0xc9, 30, 20)]);
    expect(readImageHeader(filled)).toEqual({ ok: true, type: 'image/jpeg', width: 30, height: 20 });
    expect(readImageHeader(jpeg(sof(0xc0, 65_535, 65_535)))).toMatchObject({ ok: true, width: 65_535, height: 65_535 });
  });

  it('skips DHT (C4), JPG (C8) and DAC (CC): they are not frame headers', () => {
    expect(readImageHeader(jpeg(segment(0xc8, Buffer.alloc(10)), segment(0xcc, Buffer.alloc(2)), DHT, sof(0xc1, 7, 9)))).toMatchObject({ ok: true, width: 7, height: 9 });
  });

  it('refuses a JPEG without a readable frame header', () => {
    expect(readImageHeader(jpeg(APP0, DQT, SOS))).toEqual({ ok: false, reason: 'malformed' }); // SOS before SOF
    expect(readImageHeader(Buffer.concat([SOI, APP0, EOI]))).toEqual({ ok: false, reason: 'malformed' }); // EOI before SOF
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(Buffer.concat([SOI, APP0.subarray(0, 10)]))).toEqual({ ok: false, reason: 'malformed' }); // length past the end
    expect(readImageHeader(Buffer.concat([SOI, sof(0xc0, 640, 480).subarray(0, 8)]))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(Buffer.concat([SOI, APP0, Buffer.from([0x00, 0x11]), sof(0xc0, 1, 1)]))).toEqual({ ok: false, reason: 'malformed' }); // not a marker
    expect(readImageHeader(jpeg(Buffer.from([0xff, 0xe0, 0x00, 0x01])))).toEqual({ ok: false, reason: 'malformed' }); // length < 2
    expect(readImageHeader(jpeg(sof(0xc0, 640, 0)))).toEqual({ ok: false, reason: 'malformed' }); // height from a DNL
    expect(readImageHeader(jpeg(sof(0xc0, 0, 480)))).toEqual({ ok: false, reason: 'malformed' });
    expect(readImageHeader(jpeg(segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 3]))))).toEqual({ ok: false, reason: 'malformed' }); // components missing
  });

  it('says unsupported for anything else', () => {
    expect(readImageHeader(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(readImageHeader(new TextEncoder().encode('GIF89a'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(readImageHeader(new Uint8Array(0))).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('withinImageLimits', () => {
  it('allows up to the side and pixel limits, refuses beyond', () => {
    expect(IMAGE_MAX_SIDE * IMAGE_MAX_SIDE).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
    expect(withinImageLimits({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE })).toBe(true);
    expect(withinImageLimits({ width: IMAGE_MAX_SIDE + 1, height: 10 })).toBe(false);
    expect(withinImageLimits({ width: 10, height: IMAGE_MAX_SIDE + 1 })).toBe(false);
    expect(withinImageLimits({ width: 45_000, height: 45_000 })).toBe(false);
  });
});

function job(assets: { path: string; bytes: Uint8Array }[], data = '{}') {
  return { data, options: '{}', assets };
}

describe('unsafeRenderInput (the renderer refuses before Typst sees the input)', () => {
  it('refuses an oversized or unreadable image asset and an oversized input; lets normal ones through', () => {
    expect(unsafeRenderInput(job([{ path: '/__assets/logo.png', bytes: png(160, 48) }]))).toBeNull();
    expect(unsafeRenderInput(job([{ path: '/__assets/logo.png', bytes: png(45_000, 45_000, 1, 0) }]))).toMatch(/image too large/);
    expect(unsafeRenderInput(job([{ path: '/__assets/logo.jpg', bytes: jpeg(sof(0xc0, 5000, 100)) }]))).toMatch(/image too large/);
    expect(unsafeRenderInput(job([{ path: '/__assets/logo.jpg', bytes: jpeg(APP0, SOS) }]))).toMatch(/unreadable image header/);
    expect(unsafeRenderInput(job([], 'x'.repeat(RENDER_INPUT_MAX_BYTES + 1)))).toMatch(/render input too large/);
  });
});
