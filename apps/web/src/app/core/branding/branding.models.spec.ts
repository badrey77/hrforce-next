import { EFFECTIVE_BRANDED, NO_TEXT, PUBLIC_BRANDED, text3 } from '../../../testing/branding-fixtures';
import { BRAND_COLORS, BUILT_IN_BRANDING, effectiveOf, effectiveOfPublic, isBrandColor, resolve, safeLogo } from './branding.models';

describe('branding models (docs/contracts/branding.md › Views, › Language and built-in fallback)', () => {
  describe('resolve()', () => {
    const text = text3('Bonjour', 'مرحبا', 'Hello');

    it('returns the active language and says which language it is', () => {
      expect(resolve(text, 'ar')).toEqual({ text: 'مرحبا', lang: 'ar' });
      expect(resolve(text, 'en')).toEqual({ text: 'Hello', lang: 'en' });
      expect(resolve(text, 'fr')).toEqual({ text: 'Bonjour', lang: 'fr' });
    });

    it('falls back to French, and reports French as the language of the text', () => {
      expect(resolve(text3('Bonjour'), 'ar')).toEqual({ text: 'Bonjour', lang: 'fr' });
      expect(resolve(text3('Bonjour', null, ''), 'en')).toEqual({ text: 'Bonjour', lang: 'fr' });
    });

    it('returns null when nothing is set (the caller uses the built-in text), also for a missing triple', () => {
      expect(resolve(NO_TEXT, 'fr')).toBeNull();
      expect(resolve(NO_TEXT, 'ar')).toBeNull();
      expect(resolve(null, 'fr')).toBeNull();
      expect(resolve(undefined, 'en')).toBeNull();
    });
  });

  it('the palette has the ten codes of the contract, in its order, blue first', () => {
    expect([...BRAND_COLORS]).toEqual(['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate']);
    expect(isBrandColor('plum')).toBe(true);
    expect(isBrandColor('red')).toBe(false);
    expect(isBrandColor('#ff0000')).toBe(false);
    expect(isBrandColor(null)).toBe(false);
  });

  it('safeLogo keeps only the API’s own same-origin paths', () => {
    const logo = { url: '/api/branding/logos/app/abc', width: 10, height: 10 };
    expect(safeLogo(logo)).toBe(logo);
    expect(safeLogo({ ...logo, url: 'https://evil.example/x.png' })).toBeNull();
    expect(safeLogo({ ...logo, url: '//evil.example/api/branding/x' })).toBeNull();
    expect(safeLogo({ ...logo, url: 'javascript:alert(1)' })).toBeNull();
    expect(safeLogo(null)).toBeNull();
  });

  it('effectiveOf: absent = built-in; an unknown colour is drawn as the default, never passed on', () => {
    expect(effectiveOf(null)).toBe(BUILT_IN_BRANDING);
    expect(effectiveOf(undefined)).toBe(BUILT_IN_BRANDING);
    expect(effectiveOf(EFFECTIVE_BRANDED)).toEqual(EFFECTIVE_BRANDED);
    const odd = effectiveOf({ ...EFFECTIVE_BRANDED, color: 'red; background:url(x)' as never, appLogo: { url: 'http://x/y.png', width: 1, height: 1 } });
    expect(odd.color).toBe('blue');
    expect(odd.appLogo).toBeNull();
    // A partial object (older API) is completed with "not set".
    expect(effectiveOf({ color: 'navy' })).toEqual({ ...BUILT_IN_BRANDING, color: 'navy' });
  });

  it('effectiveOfPublic: the installation default in the same shape, without welcome texts or company logo', () => {
    expect(effectiveOfPublic(PUBLIC_BRANDED)).toEqual({
      appTitle: PUBLIC_BRANDED.appTitle,
      welcomeTitle: NO_TEXT,
      welcomeMessage: NO_TEXT,
      footer: PUBLIC_BRANDED.footer,
      color: 'teal',
      appLogo: PUBLIC_BRANDED.appLogo,
      companyLogo: null,
    });
  });
});
