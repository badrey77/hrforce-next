import { formatFileSize } from './file-size.pipe';

/** `Intl` may use a narrow no-break space between number and unit: compare with plain spaces. */
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('formatFileSize', () => {
  it('formats bytes, kilobytes and megabytes in the UI language with Latin digits', () => {
    expect(formatFileSize(250_000, 'en')).toBe('244 kB');
    expect(formatFileSize(10 * 1024 * 1024, 'en')).toBe('10 MB');
    expect(plain(formatFileSize(2.5 * 1024 * 1024, 'fr'))).toBe('2,5 Mo');
    expect(formatFileSize(2.5 * 1024 * 1024, 'ar')).toMatch(/^2[.,٫]5/);
  });

  it('writes bytes as a word with the plural of each language (never "800 byte")', () => {
    expect(formatFileSize(1, 'en')).toBe('1 byte');
    expect(formatFileSize(800, 'en')).toBe('800 bytes');
    expect(plain(formatFileSize(1, 'fr'))).toBe('1 octet');
    expect(plain(formatFileSize(800, 'fr'))).toBe('800 octets');
    expect(formatFileSize(800, 'ar')).toMatch(/^800 .*بايت/);
  });
});
