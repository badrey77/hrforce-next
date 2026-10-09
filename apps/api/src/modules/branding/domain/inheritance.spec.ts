import { describe, expect, it } from 'vitest';
import { inheritedLevel, logoUrl, resolveBranding } from './inheritance.js';
import type { CompanyLevel, InstallationLevel, Lang3, LogoMeta } from './types.js';

const L0: Lang3 = { fr: null, ar: null, en: null };
const t = (fr: string, ar: string | null = null, en: string | null = null): Lang3 => ({ fr, ar, en });
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const logo = (digest: string, width = 160, height = 48): LogoMeta => ({ digest, mime: 'image/png', width, height });

const EMPTY_COMPANY: CompanyLevel = { appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: null, appLogo: null, companyLogo: null };
const INSTALLATION: InstallationLevel = {
  appTitle: t('Portail RH', 'بوابة', 'HR portal'),
  signInMessage: t('Message de connexion'),
  footer: t('Pied installation', 'تذييل'),
  color: 'navy',
  appLogo: logo(A),
};
const COMPANY: CompanyLevel = {
  appTitle: t('RH Société'),
  welcomeTitle: t('Bienvenue', 'مرحبا'),
  welcomeMessage: t('Message'),
  footer: t('Pied société'),
  color: 'teal',
  appLogo: logo(B, 200, 50),
  companyLogo: logo(C, 300, 100),
};

describe('logo URLs', () => {
  it('are same-origin, under /api/branding/, and carry the digest', () => {
    expect(logoUrl('default', A)).toBe(`/api/branding/default/logo/${A}`);
    expect(logoUrl('app', B)).toBe(`/api/branding/logos/app/${B}`);
    expect(logoUrl('company', C)).toBe(`/api/branding/logos/company/${C}`);
  });
});

describe('resolveBranding (company → installation → built-in)', () => {
  it('nothing anywhere: all null, blue, no logo', () => {
    const builtIn = { appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: 'blue', appLogo: null, companyLogo: null };
    expect(resolveBranding(null, null)).toEqual(builtIn);
    expect(resolveBranding(EMPTY_COMPANY, null)).toEqual(builtIn);
  });

  it('installation only (no company row, or an empty one): its title, footer, colour and logo with the default URL; no welcome texts', () => {
    const expected = {
      appTitle: INSTALLATION.appTitle,
      welcomeTitle: L0,
      welcomeMessage: L0,
      footer: INSTALLATION.footer,
      color: 'navy',
      appLogo: { url: `/api/branding/default/logo/${A}`, width: 160, height: 48 },
      companyLogo: null,
    };
    expect(resolveBranding(null, INSTALLATION)).toEqual(expected);
    expect(resolveBranding(EMPTY_COMPANY, INSTALLATION)).toEqual(expected);
  });

  it('company only: its own values; nothing inherited', () => {
    expect(resolveBranding(COMPANY, null)).toEqual({
      appTitle: COMPANY.appTitle,
      welcomeTitle: COMPANY.welcomeTitle,
      welcomeMessage: COMPANY.welcomeMessage,
      footer: COMPANY.footer,
      color: 'teal',
      appLogo: { url: `/api/branding/logos/app/${B}`, width: 200, height: 50 },
      companyLogo: { url: `/api/branding/logos/company/${C}`, width: 300, height: 100 },
    });
  });

  it('both: the company wins on every field it set', () => {
    expect(resolveBranding(COMPANY, INSTALLATION)).toEqual(resolveBranding(COMPANY, null));
  });

  it('field by field: each company field left empty falls back on its own', () => {
    const base = resolveBranding(COMPANY, INSTALLATION);
    expect(resolveBranding({ ...COMPANY, appTitle: L0 }, INSTALLATION)).toEqual({ ...base, appTitle: INSTALLATION.appTitle });
    expect(resolveBranding({ ...COMPANY, footer: L0 }, INSTALLATION)).toEqual({ ...base, footer: INSTALLATION.footer });
    expect(resolveBranding({ ...COMPANY, color: null }, INSTALLATION)).toEqual({ ...base, color: 'navy' });
    expect(resolveBranding({ ...COMPANY, appLogo: null }, INSTALLATION)).toEqual({ ...base, appLogo: { url: `/api/branding/default/logo/${A}`, width: 160, height: 48 } });
    // the company's own fields have no installation level
    expect(resolveBranding({ ...COMPANY, welcomeTitle: L0 }, INSTALLATION)).toEqual({ ...base, welcomeTitle: L0 });
    expect(resolveBranding({ ...COMPANY, welcomeMessage: L0 }, INSTALLATION)).toEqual({ ...base, welcomeMessage: L0 });
    expect(resolveBranding({ ...COMPANY, companyLogo: null }, INSTALLATION)).toEqual({ ...base, companyLogo: null });
    // and down to the built-in value when the installation has none either
    const bare: InstallationLevel = { appTitle: L0, signInMessage: L0, footer: L0, color: 'blue', appLogo: null };
    expect(resolveBranding({ ...COMPANY, appTitle: L0, footer: L0, color: null, appLogo: null }, bare)).toEqual({ ...base, appTitle: L0, footer: L0, color: 'blue', appLogo: null });
  });

  it('a text is inherited as a whole triple, never mixed per language', () => {
    // the company set French only: Arabic is NOT taken from the installation
    expect(resolveBranding({ ...EMPTY_COMPANY, appTitle: t('RH') }, INSTALLATION).appTitle).toEqual({ fr: 'RH', ar: null, en: null });
    expect(resolveBranding({ ...EMPTY_COMPANY, footer: t('Pied', null, 'Footer') }, INSTALLATION).footer).toEqual({ fr: 'Pied', ar: null, en: 'Footer' });
  });

  it('never carries the sign-in message, and returns copies', () => {
    const result = resolveBranding(COMPANY, INSTALLATION);
    expect(Object.keys(result).toSorted()).toEqual(['appLogo', 'appTitle', 'color', 'companyLogo', 'footer', 'welcomeMessage', 'welcomeTitle']);
    expect(result.appTitle).not.toBe(COMPANY.appTitle);
  });
});

describe('inheritedLevel', () => {
  it('is the installation default, or the built-in values without a row', () => {
    expect(inheritedLevel(INSTALLATION)).toEqual({
      appTitle: INSTALLATION.appTitle,
      footer: INSTALLATION.footer,
      color: 'navy',
      appLogo: { url: `/api/branding/default/logo/${A}`, width: 160, height: 48 },
    });
    expect(inheritedLevel(null)).toEqual({ appTitle: L0, footer: L0, color: 'blue', appLogo: null });
  });
});
