import { describe, expect, it } from 'vitest';
import { cleanBrandingText, codePointLength, validateBrandColor, validateBrandingTexts } from './text.js';
import { BRAND_COLORS, BRANDING_LIMITS, BRANDING_TEXT_FIELDS } from './types.js';

const L0 = { fr: null, ar: null, en: null };

describe('cleanBrandingText', () => {
  it('null, empty and blank → null', () => {
    expect(cleanBrandingText(null, false)).toBeNull();
    expect(cleanBrandingText(undefined, false)).toBeNull();
    expect(cleanBrandingText('', false)).toBeNull();
    expect(cleanBrandingText('  \t \r\n ', false)).toBeNull();
    expect(cleanBrandingText(' \n\n ', true)).toBeNull();
    expect(cleanBrandingText('​‮﻿', true)).toBeNull();
  });

  it('normalises to NFC', () => {
    expect(cleanBrandingText('Société', false)).toBe('Société');
    expect(cleanBrandingText('Société', false)).toHaveLength(7);
  });

  it('removes C0, DEL and C1 control characters', () => {
    expect(cleanBrandingText('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg', false)).toBe('abcdefg');
    expect(cleanBrandingText('a\u0000b\u0085c', true)).toBe('abc');
  });

  it('removes zero-width characters and every bidi mark and control, keeps ZWNJ / ZWJ', () => {
    const bidi = ['‎', '‏', '؜', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '​', '﻿'];
    for (const mark of bidi) expect(cleanBrandingText(`ab${mark}cd`, false), mark.codePointAt(0)?.toString(16)).toBe('abcd');
    // an RTL override would mirror what follows it on the page
    expect(cleanBrandingText('Groupe ‮omeD‬ SPA', false)).toBe('Groupe omeD SPA');
    expect(cleanBrandingText('می‌خواهم', false)).toBe('می‌خواهم');
    expect(cleanBrandingText('a‍b', false)).toBe('a‍b');
  });

  it('leaves Arabic text untouched', () => {
    const text = 'مجموعة ديمو — الدعم: support@demo.dz';
    expect(cleanBrandingText(text, false)).toBe(text);
    expect(cleanBrandingText('مَرْحَبًا بِكُمْ', true)).toBe('مَرْحَبًا بِكُمْ'.normalize('NFC'));
  });

  it('keeps markup characters verbatim: text is data, nothing is escaped or removed', () => {
    for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'R&D "Groupe" <b>', "O'Brien & fils"]) {
      expect(cleanBrandingText(text, false)).toBe(text);
      expect(cleanBrandingText(text, true)).toBe(text);
    }
  });

  it('single-line: line breaks and tabs become spaces, runs of spaces collapse, trimmed', () => {
    expect(cleanBrandingText('  Groupe\r\nDémo\t\tSPA \r ', false)).toBe('Groupe Démo SPA');
    expect(cleanBrandingText('a\n\n\nb', false)).toBe('a b');
  });

  it('multi-line: CRLF / CR → LF, three or more breaks → two, spaces around breaks dropped, trimmed', () => {
    expect(cleanBrandingText('Bonjour\r\ntout le monde\rici', true)).toBe('Bonjour\ntout le monde\nici');
    expect(cleanBrandingText('a\n\n\n\n\nb', true)).toBe('a\n\nb');
    expect(cleanBrandingText('a \n \n \n b', true)).toBe('a\n\nb');
    expect(cleanBrandingText('\n\n  a   b  \n c\t d \n\n', true)).toBe('a b\nc d');
  });

  it('drops half surrogate pairs and keeps whole ones', () => {
    expect(cleanBrandingText('a\ud83db', false)).toBe('ab');
    expect(cleanBrandingText('a\ude00b', false)).toBe('ab');
    expect(cleanBrandingText('a😀b', false)).toBe('a😀b');
  });
});

describe('validateBrandingTexts', () => {
  it('counts code points, not UTF-16 units: 40 emoji fit a title, 41 do not', () => {
    expect(codePointLength('😀'.repeat(40))).toBe(40);
    expect('😀'.repeat(40)).toHaveLength(80);
    const ok = validateBrandingTexts({ appTitle: { fr: '😀'.repeat(40), ar: 'ع'.repeat(40), en: 'x'.repeat(40) } });
    expect(ok.errors).toEqual([]);
    const ko = validateBrandingTexts({ appTitle: { fr: '😀'.repeat(41), ar: 'ع'.repeat(41), en: 'x'.repeat(41) } });
    expect(ko.errors.map((e) => [e.field, e.code])).toEqual([['appTitle.fr', 'too_long'], ['appTitle.ar', 'too_long'], ['appTitle.en', 'too_long']]);
  });

  it('measures after cleaning (a decomposed or padded text within the limit is accepted)', () => {
    const decomposed = 'é'.repeat(40);
    expect(validateBrandingTexts({ appTitle: { fr: `  ${decomposed}​  `, ar: null, en: null } })).toEqual({ values: { appTitle: { fr: 'é'.repeat(40), ar: null, en: null } }, errors: [] });
  });

  it('applies each field its own limit', () => {
    for (const [name, rule] of Object.entries(BRANDING_TEXT_FIELDS)) {
      const field = name as keyof typeof BRANDING_TEXT_FIELDS;
      expect(rule.max).toBe(BRANDING_LIMITS[field]);
      expect(validateBrandingTexts({ [field]: { fr: 'x'.repeat(rule.max), ar: null, en: null } } as never).errors).toEqual([]);
      expect(validateBrandingTexts({ [field]: { fr: 'x'.repeat(rule.max + 1), ar: null, en: null } } as never).errors.map((e) => [e.field, e.code])).toEqual([[`${name}.fr`, 'too_long']]);
    }
  });

  it('French is required as soon as Arabic or English is set', () => {
    expect(validateBrandingTexts({ footer: { fr: null, ar: 'تذييل', en: null } }).errors.map((e) => [e.field, e.code])).toEqual([['footer.fr', 'fr_required']]);
    expect(validateBrandingTexts({ footer: { fr: ' ​ ', ar: null, en: 'Footer' } }).errors.map((e) => [e.field, e.code])).toEqual([['footer.fr', 'fr_required']]);
    expect(validateBrandingTexts({ footer: { fr: 'Pied', ar: null, en: null } }).errors).toEqual([]);
    expect(validateBrandingTexts({ footer: L0 })).toEqual({ values: { footer: L0 }, errors: [] });
  });

  it('multi-line fields hold at most 6 lines; single-line fields have no line limit (breaks become spaces)', () => {
    const six = ['1', '2', '3', '4', '5', '6'].join('\n');
    expect(validateBrandingTexts({ welcomeMessage: { fr: six, ar: null, en: null } }).errors).toEqual([]);
    expect(validateBrandingTexts({ signInMessage: { fr: `${six}\n7`, ar: null, en: null } }).errors.map((e) => [e.field, e.code])).toEqual([['signInMessage.fr', 'too_many_lines']]);
    expect(validateBrandingTexts({ footer: { fr: `${six}\n7`, ar: null, en: null } })).toEqual({ values: { footer: { fr: '1 2 3 4 5 6 7', ar: null, en: null } }, errors: [] });
  });

  it('returns the cleaned values', () => {
    const { values } = validateBrandingTexts({ appTitle: { fr: ' <b>RH</b>‮ ', ar: ' موارد ', en: '' }, welcomeMessage: { fr: 'a\r\n\r\n\r\nb', ar: null, en: null } });
    expect(values).toEqual({ appTitle: { fr: '<b>RH</b>', ar: 'موارد', en: null }, welcomeMessage: { fr: 'a\n\nb', ar: null, en: null } });
  });
});

describe('validateBrandColor', () => {
  it('accepts the ten codes; null only where the level may inherit', () => {
    for (const code of BRAND_COLORS) expect(validateBrandColor(code, false)).toEqual({ color: code });
    expect(BRAND_COLORS).toHaveLength(10);
    expect(validateBrandColor(null, true)).toEqual({ color: null });
    expect(validateBrandColor(null, false).error).toMatchObject({ field: 'color', code: 'invalid_color' });
  });

  it('refuses anything else — a hex value, another case, red', () => {
    for (const value of ['#1f4e79', 'Blue', 'red', 'bordeaux', '', 'blue; background:url(x)']) {
      expect(validateBrandColor(value, true).error, value).toMatchObject({ field: 'color', code: 'invalid_color' });
    }
  });
});
