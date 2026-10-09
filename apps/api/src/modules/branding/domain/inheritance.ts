import {
  DEFAULT_BRAND_COLOR,
  EMPTY_LANG3,
  type BrandColor,
  type CompanyLevel,
  type EffectiveBranding,
  type InstallationLevel,
  type Lang3,
  type LogoMeta,
  type LogoRef,
} from './types.js';

/**
 * Inheritance between the two levels (docs/contracts/branding.md › Views › Inheritance). Pure.
 * The API resolves the LEVELS; the language (and the built-in fallback « HRForce », the web's own i18n texts) is
 * the web's.
 */

export type LogoSource = 'default' | 'app' | 'company';

/** The logo URLs — built here only; the web never builds one. The digest makes each URL immutable. */
export function logoUrl(source: LogoSource, digest: string): string {
  return source === 'default' ? `/api/branding/default/logo/${digest}` : `/api/branding/logos/${source}/${digest}`;
}

export function logoRef(source: LogoSource, logo: LogoMeta | null | undefined): LogoRef | null {
  return logo ? { url: logoUrl(source, logo.digest), width: logo.width, height: logo.height } : null;
}

const copy = (t: Lang3): Lang3 => ({ fr: t.fr, ar: t.ar, en: t.en });

/** The company's triple when its French is set, else the installation's — the WHOLE triple, never mixed per language. */
function inheritText(company: Lang3 | undefined, installation: Lang3 | undefined): Lang3 {
  if (company && company.fr !== null) return copy(company);
  return copy(installation ?? EMPTY_LANG3);
}

/** What an empty company field falls back to: the installation default (built-in when there is no row). */
export function inheritedLevel(installation: InstallationLevel | null): { appTitle: Lang3; footer: Lang3; color: BrandColor; appLogo: LogoRef | null } {
  return {
    appTitle: copy(installation?.appTitle ?? EMPTY_LANG3),
    footer: copy(installation?.footer ?? EMPTY_LANG3),
    color: installation?.color ?? DEFAULT_BRAND_COLOR,
    appLogo: logoRef('default', installation?.appLogo),
  };
}

/**
 * appTitle, footer: company, else installation. color, appLogo: company, else installation (an inherited logo
 * carries the `default` URL). welcomeTitle, welcomeMessage, companyLogo: the company's only. The sign-in message is
 * the installation's only and is not part of the result (never shown after sign-in).
 */
export function resolveBranding(company: CompanyLevel | null, installation: InstallationLevel | null): EffectiveBranding {
  return {
    appTitle: inheritText(company?.appTitle, installation?.appTitle),
    welcomeTitle: copy(company?.welcomeTitle ?? EMPTY_LANG3),
    welcomeMessage: copy(company?.welcomeMessage ?? EMPTY_LANG3),
    footer: inheritText(company?.footer, installation?.footer),
    color: company?.color ?? installation?.color ?? DEFAULT_BRAND_COLOR,
    appLogo: company?.appLogo ? logoRef('app', company.appLogo) : logoRef('default', installation?.appLogo),
    companyLogo: logoRef('company', company?.companyLogo),
  };
}
