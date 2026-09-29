import { formatFileSize } from './file-size.pipe';

describe('formatFileSize', () => {
  it('formats bytes, kilobytes and megabytes in the UI language with Latin digits', () => {
    expect(formatFileSize(800, 'en')).toBe('800 byte');
    expect(formatFileSize(250_000, 'en')).toBe('244 kB');
    expect(formatFileSize(10 * 1024 * 1024, 'en')).toBe('10 MB');
    expect(formatFileSize(2.5 * 1024 * 1024, 'fr').replace(/\s/g, ' ')).toBe('2,5 Mo');
    expect(formatFileSize(2.5 * 1024 * 1024, 'ar')).toMatch(/^2[.,٫]5/);
  });
});
