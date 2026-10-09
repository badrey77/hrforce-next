import type { BrandColor, Lang3, LogoMime, LogoRef } from '../domain/types.js';

/**
 * Response shapes of the Branding module (docs/contracts/branding.md › Views — shared with the web, final).
 * No key matches /(password|hash|token|secret)/i: an image's digest only appears inside `url`.
 */

export interface LogoView extends LogoRef {
  mime: LogoMime;
  sizeBytes: number;
}

/** GET /api/branding/default (public): the installation default, raw. All null + 'blue' when nothing is set. */
export interface PublicBranding {
  appTitle: Lang3;
  signInMessage: Lang3;
  footer: Lang3;
  color: BrandColor;
  appLogo: LogoRef | null;
}

/** Admin: what is stored for the company (null = inherit / built-in). */
export interface CompanyBrandingView {
  appTitle: Lang3;
  welcomeTitle: Lang3;
  welcomeMessage: Lang3;
  footer: Lang3;
  color: BrandColor | null;
  appLogo: LogoView | null;
  companyLogo: LogoView | null;
  updatedAt: string | null;
}

/** Admin: the installation default as stored. */
export interface InstallationBrandingView {
  appTitle: Lang3;
  signInMessage: Lang3;
  footer: Lang3;
  color: BrandColor;
  appLogo: LogoView | null;
  updatedAt: string | null;
}

export interface BrandingSettingsView {
  company: CompanyBrandingView;
  /** null when the caller's company is not the owning company (the web then hides the installation tab). */
  installation: InstallationBrandingView | null;
  /** What an empty company field falls back to (= the installation default). */
  inherited: { appTitle: Lang3; footer: Lang3; color: BrandColor; appLogo: LogoRef | null };
  /** the ten codes, in the order of the contract's table */
  palette: BrandColor[];
  limits: { appTitle: 40; welcomeTitle: 80; welcomeMessage: 500; signInMessage: 500; footer: 200; logoMaxBytes: 262144 };
}

/** A logo with its bytes (the image routes). */
export interface LogoFile {
  bytes: Buffer;
  mime: LogoMime;
  /** 64 lower-case hex characters */
  digest: string;
}
