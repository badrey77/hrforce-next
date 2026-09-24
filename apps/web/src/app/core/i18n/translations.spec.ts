import ar from '../../../../public/i18n/ar.json';
import en from '../../../../public/i18n/en.json';
import fr from '../../../../public/i18n/fr.json';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('translation files', () => {
  it('fr and ar have identical key sets', () => {
    expect(keys(ar).toSorted()).toEqual(keys(fr).toSorted());
  });

  it('en has no keys unknown to fr', () => {
    const frKeys = new Set(keys(fr));
    expect(keys(en).filter((k) => !frKeys.has(k))).toEqual([]);
  });

  it('has no empty strings', () => {
    for (const file of [fr, ar, en]) {
      const empty = keys(file).filter((k) => {
        const value = k.split('.').reduce<unknown>(
          (node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined),
          file,
        );
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(empty).toEqual([]);
    }
  });
});
