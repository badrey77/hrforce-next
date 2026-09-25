import { safeReturnUrl } from './return-url';

describe('safeReturnUrl', () => {
  it.each([
    ['/', '/'],
    ['/organization', '/organization'],
    ['/organization?asOf=2025-01-31#top', '/organization?asOf=2025-01-31#top'],
  ])('keeps the internal path %s', (input, expected) => {
    expect(safeReturnUrl(input)).toBe(expected);
  });

  it.each([
    ['https://evil.example/login'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['javascript:alert(1)'],
    ['/\t/evil.example'],
    ['organization'],
    [''],
    [undefined],
    [42],
  ])('rejects %s (falls back to /)', (input) => {
    expect(safeReturnUrl(input)).toBe('/');
  });

  it('uses the given fallback', () => {
    expect(safeReturnUrl('//x', '/home')).toBe('/home');
  });
});
