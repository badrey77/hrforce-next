import { describe, expect, it } from 'vitest';
import { addYears, attachmentDisposition, downloadFilename, isPurgeDue, permissionsFor, sanitizeFilename, sniffFileType } from './employee-files.js';

const pdf = (body = '') => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.alloc(8)]);

describe('sniffFileType', () => {
  it('recognises PDF, JPEG and PNG by their bytes', () => {
    expect(sniffFileType(pdf('1 0 obj'))).toBe('application/pdf');
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffFileType(png)).toBe('image/png');
  });

  it('refuses a PDF header without an end, a PDF inside HTML, SVG, text, an empty buffer and a bare PNG signature', () => {
    expect(sniffFileType(Buffer.from('%PDF-1.4\n<script>alert(1)</script>', 'latin1'))).toBeNull();
    expect(sniffFileType(Buffer.from(`<html><script>x</script>${pdf().toString('latin1')}`, 'latin1'))).toBeNull();
    expect(sniffFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffFileType(Buffer.from('%PDF-x.y\n%%EOF'))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
    expect(sniffFileType(png.subarray(0, 8))).toBeNull();
  });

  it('needs %%EOF within the last 1 KB', () => {
    expect(sniffFileType(Buffer.concat([pdf(), Buffer.alloc(2048, 0x20)]))).toBeNull();
    expect(sniffFileType(Buffer.concat([pdf(), Buffer.alloc(1000, 0x20)]))).toBe('application/pdf');
  });
});

describe('file names', () => {
  it('keeps the last path part without control and bidi characters', () => {
    expect(sanitizeFilename('C:\\Users\\x\\rapport.pdf')).toBe('rapport.pdf');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('fac\u202Etxt.exe')).toBe('factxt.exe');
    expect(sanitizeFilename('a\r\nb"c.pdf')).toBe('ab"c.pdf');
    expect(sanitizeFilename('شهادة.pdf')).toBe('شهادة.pdf');
    expect(sanitizeFilename('')).toBe('fichier');
    expect(sanitizeFilename('..')).toBe('fichier');
    expect(sanitizeFilename(undefined)).toBe('fichier');
    expect(Array.from(sanitizeFilename('x'.repeat(300)))).toHaveLength(200);
  });

  it('downloads under an extension matching the sniffed type', () => {
    expect(downloadFilename('page.html', 'application/pdf')).toBe('page.html.pdf');
    expect(downloadFilename('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG');
    expect(downloadFilename('scan', 'image/png')).toBe('scan.png');
  });

  it('Content-Disposition: attachment, ASCII fallback, exact UTF-8 name, no quote or line break', () => {
    const header = attachmentDisposition('ab"c\r\nd شهادة (1).pdf');
    expect(header).toBe(`attachment; filename="ab_c__d________1_.pdf"; filename*=UTF-8''ab%22c%0D%0Ad%20${encodeURIComponent('شهادة')}%20%281%29.pdf`);
    expect(header).not.toMatch(/[\r\n]/);
  });
});

describe('access and retention', () => {
  it('medical needs the medical permission on top', () => {
    expect(permissionsFor('read', 'standard')).toEqual(['employee_file.read']);
    expect(permissionsFor('read', 'medical')).toEqual(['employee_file.read', 'employee.medical.read']);
    expect(permissionsFor('upload', 'medical')).toEqual(['employee_file.upload', 'employee.medical.update']);
    expect(permissionsFor('delete', 'medical')).toEqual(['employee_file.delete', 'employee.medical.update']);
  });

  it('addYears handles 29 February', () => {
    expect(addYears('2020-02-29', 1)).toBe('2021-02-28');
    expect(addYears('2020-06-30', 5)).toBe('2025-06-30');
  });

  it('purges only when every employment ended and the last end + N years is past', () => {
    const today = '2026-09-29';
    expect(isPurgeDue({ retentionYears: null, endDates: ['2000-01-01'], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 5, endDates: ['2020-06-30'], today })).toBe(true);
    expect(isPurgeDue({ retentionYears: 10, endDates: ['2020-06-30'], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 1, endDates: ['2010-01-01', null], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 1, endDates: ['2010-01-01', '2026-01-01'], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 1, endDates: [], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 1, endDates: ['2025-09-29'], today })).toBe(false);
    expect(isPurgeDue({ retentionYears: 1, endDates: ['2025-09-28'], today })).toBe(true);
  });
});
