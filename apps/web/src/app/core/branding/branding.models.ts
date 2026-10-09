/**
 * Branding contract types and the two pure rules the web owns (docs/contracts/branding.md › Views, › Web).
 * Field names match the contract exactly: the API is built from the same document.
 */
import { type AppLanguage, DEFAULT_LANGUAGE } from '../i18n/languages';

/**
 * The palette codes, in the contract's order. The hex values live ONLY in `styles.css` (`[data-brand='<code>']`):
 * the web never builds a colour from server data, it only names one of these codes.
 */
export const BRAND_COLORS = ['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate'] as const;
export type BrandColor = (typeof BRAND_COLORS)[number];
export const DEFAULT_BRAND_COLOR: BrandColor = 'blue';

export function isBrandColor(value: unknown): value is BrandColor {
  return typeof value === 'string' && (BRAND_COLORS as readonly string[]).includes(value);
}

/** One text in three languages. `fr` is non-null whenever `ar` or `en` is; all null = "not set". */
export interface Lang3 {
  readonly fr: string | null;
  readonly ar: string | null;
  readonly en: string | null;
}
export const EMPTY_LANG3: Lang3 = { fr: null, ar: null, en: null };

/** `url` is same-origin, starts with `/api/branding/`, and changes whenever the image changes. */
export interface LogoRef {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}
export interface LogoView extends LogoRef {
  readonly mime: 'image/png' | 'image/jpeg';
  readonly sizeBytes: number;
}

/** `GET /api/branding/default` (public): the installation default, raw. */
export interface PublicBranding {
  readonly appTitle: Lang3;
  readonly signInMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor;
  readonly appLogo: LogoRef | null;
}

/** `GET /api/me` → `branding`: the caller's company after inheritance. */
export interface EffectiveBranding {
  readonly appTitle: Lang3;
  readonly welcomeTitle: Lang3;
  readonly welcomeMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor;
  readonly appLogo: LogoRef | null;
  readonly companyLogo: LogoRef | null;
}

/** What the app shows when nothing is set (or nothing could be loaded): its own i18n texts, blue, no logo. */
export const BUILT_IN_BRANDING: EffectiveBranding = {
  appTitle: EMPTY_LANG3,
  welcomeTitle: EMPTY_LANG3,
  welcomeMessage: EMPTY_LANG3,
  footer: EMPTY_LANG3,
  color: DEFAULT_BRAND_COLOR,
  appLogo: null,
  companyLogo: null,
};

export interface CompanyBrandingView {
  readonly appTitle: Lang3;
  readonly welcomeTitle: Lang3;
  readonly welcomeMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor | null;
  readonly appLogo: LogoView | null;
  readonly companyLogo: LogoView | null;
  readonly updatedAt: string | null;
}

export interface InstallationBrandingView {
  readonly appTitle: Lang3;
  readonly signInMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor;
  readonly appLogo: LogoView | null;
  readonly updatedAt: string | null;
}

export interface BrandingLimits {
  readonly appTitle: number;
  readonly welcomeTitle: number;
  readonly welcomeMessage: number;
  readonly signInMessage: number;
  readonly footer: number;
  readonly logoMaxBytes: number;
}

export interface BrandingSettingsView {
  readonly company: CompanyBrandingView;
  /** null when the caller's company is not the owning company. */
  readonly installation: InstallationBrandingView | null;
  /** What an empty company field falls back to. */
  readonly inherited: { readonly appTitle: Lang3; readonly footer: Lang3; readonly color: BrandColor; readonly appLogo: LogoRef | null };
  readonly palette: readonly BrandColor[];
  readonly limits: BrandingLimits;
}

/** `PUT /branding/company` body (all five keys, full replacement). */
export interface CompanyBrandingBody {
  readonly appTitle: Lang3;
  readonly welcomeTitle: Lang3;
  readonly welcomeMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor | null;
}

/** `PUT /branding/installation` body. */
export interface InstallationBrandingBody {
  readonly appTitle: Lang3;
  readonly signInMessage: Lang3;
  readonly footer: Lang3;
  readonly color: BrandColor;
}

export type CompanyLogoKind = 'app' | 'company';

/** A branded text in the language it was found in (for the `lang` attribute). */
export interface ResolvedText {
  readonly text: string;
  readonly lang: AppLanguage;
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Language fallback: the active language's text, else French, else `null` (the caller then uses its own i18n text,
 * or shows nothing). Tolerates a missing or malformed triple (an older API): `null`.
 */
export function resolve(text: Lang3 | null | undefined, activeLang: AppLanguage): ResolvedText | null {
  if (!text) return null;
  const active = text[activeLang];
  if (filled(active)) return { text: active, lang: activeLang };
  return filled(text.fr) ? { text: text.fr, lang: DEFAULT_LANGUAGE } : null;
}

export const BRANDING_URL_PREFIX = '/api/branding/';

/** A logo reference is used only when its URL is the API's own same-origin path (never an absolute or foreign URL). */
export function safeLogo<T extends LogoRef>(logo: T | null | undefined): T | null {
  if (!logo || typeof logo.url !== 'string' || !logo.url.startsWith(BRANDING_URL_PREFIX)) return null;
  return logo;
}

function lang3(value: Lang3 | null | undefined): Lang3 {
  return value ?? EMPTY_LANG3;
}

/** `me.branding` as received → a complete, checked `EffectiveBranding` (absent or partial = built-in for that part). */
export function effectiveOf(branding: Partial<EffectiveBranding> | null | undefined): EffectiveBranding {
  if (!branding) return BUILT_IN_BRANDING;
  return {
    appTitle: lang3(branding.appTitle),
    welcomeTitle: lang3(branding.welcomeTitle),
    welcomeMessage: lang3(branding.welcomeMessage),
    footer: lang3(branding.footer),
    color: isBrandColor(branding.color) ? branding.color : DEFAULT_BRAND_COLOR,
    appLogo: safeLogo(branding.appLogo),
    companyLogo: safeLogo(branding.companyLogo),
  };
}

/** The public default in the same shape: no welcome texts, no company logo. */
export function effectiveOfPublic(branding: Partial<PublicBranding>): EffectiveBranding {
  return effectiveOf({ appTitle: branding.appTitle, footer: branding.footer, color: branding.color, appLogo: branding.appLogo });
}
