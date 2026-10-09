/**
 * Branding — pure types and reference data (docs/contracts/branding.md › Palette, Views). No Nest, no Kysely.
 * A colour is a CODE: the hex values live only in the web's stylesheet (apps/web/src/styles.css), the API never
 * sends one.
 */

/** The ten palette codes, in the order of the contract's table (`blue` is the built-in default). */
export const BRAND_COLORS = ['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate'] as const;
export type BrandColor = (typeof BRAND_COLORS)[number];
export const DEFAULT_BRAND_COLOR: BrandColor = 'blue';

export function isBrandColor(value: unknown): value is BrandColor {
  return typeof value === 'string' && (BRAND_COLORS as readonly string[]).includes(value);
}

export const BRANDING_PERMISSION = 'settings.branding';

/** One text in three languages. `fr` is non-null whenever `ar` or `en` is; all null = "not set". */
export interface Lang3 {
  fr: string | null;
  ar: string | null;
  en: string | null;
}

export const EMPTY_LANG3: Lang3 = Object.freeze({ fr: null, ar: null, en: null });

export const LANGS = ['fr', 'ar', 'en'] as const;

/** Text fields: maximum length in Unicode code points, and whether line breaks are kept. */
export const BRANDING_TEXT_FIELDS = {
  appTitle: { max: 40, multiline: false },
  welcomeTitle: { max: 80, multiline: false },
  welcomeMessage: { max: 500, multiline: true },
  signInMessage: { max: 500, multiline: true },
  footer: { max: 200, multiline: false },
} as const;
export type BrandingTextField = keyof typeof BRANDING_TEXT_FIELDS;

/** At most this many lines in a multi-line field (after cleaning). */
export const BRANDING_MAX_LINES = 6;

/** 256 KB, like the letterhead logo (ADR 008). */
export const BRANDING_LOGO_MAX_BYTES = 256 * 1024;

export const BRANDING_LIMITS = {
  appTitle: 40,
  welcomeTitle: 80,
  welcomeMessage: 500,
  signInMessage: 500,
  footer: 200,
  logoMaxBytes: 262144,
} as const;

export type LogoMime = 'image/png' | 'image/jpeg';
export const LOGO_KINDS = ['app', 'company'] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

export function isLogoKind(value: string): value is LogoKind {
  return (LOGO_KINDS as readonly string[]).includes(value);
}

/** A stored logo without its bytes. */
export interface LogoMeta {
  /** SHA-256 of the bytes, 64 lower-case hex characters */
  digest: string;
  mime: LogoMime;
  width: number;
  height: number;
  /** only read for the admin view (the other reads never touch the image column) */
  sizeBytes?: number;
}

/** `url` is same-origin, starts with `/api/branding/`, and changes whenever the image changes. */
export interface LogoRef {
  url: string;
  width: number;
  height: number;
}

/** What a company stores (null = inherit / built-in). */
export interface CompanyLevel {
  appTitle: Lang3;
  welcomeTitle: Lang3;
  welcomeMessage: Lang3;
  footer: Lang3;
  color: BrandColor | null;
  appLogo: LogoMeta | null;
  companyLogo: LogoMeta | null;
}

/** The installation default as stored. */
export interface InstallationLevel {
  appTitle: Lang3;
  signInMessage: Lang3;
  footer: Lang3;
  color: BrandColor;
  appLogo: LogoMeta | null;
}

/** GET /api/me → `branding`: the caller's company after inheritance. */
export interface EffectiveBranding {
  appTitle: Lang3;
  welcomeTitle: Lang3;
  welcomeMessage: Lang3;
  footer: Lang3;
  color: BrandColor;
  appLogo: LogoRef | null;
  companyLogo: LogoRef | null;
}

/** A 64-character lower-case hex SHA-256 (the `:digest` of the logo routes). */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
