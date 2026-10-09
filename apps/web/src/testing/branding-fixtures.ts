import type { HttpTestingController } from '@angular/common/http/testing';
import type {
  BrandingSettingsView,
  EffectiveBranding,
  Lang3,
  LogoView,
  PublicBranding,
} from '../app/core/branding/branding.models';

export const BRANDING_DEFAULT_URL = '/api/branding/default';
export const BRANDING_SETTINGS_URL = '/api/branding/settings';

export const NO_TEXT: Lang3 = { fr: null, ar: null, en: null };
export const text3 = (fr: string, ar: string | null = null, en: string | null = null): Lang3 => ({ fr, ar, en });

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

export const DEFAULT_LOGO: LogoView = { url: `/api/branding/default/logo/${SHA_A}`, width: 320, height: 80, mime: 'image/png', sizeBytes: 12_345 };
export const APP_LOGO: LogoView = { url: `/api/branding/logos/app/${SHA_B}`, width: 200, height: 50, mime: 'image/png', sizeBytes: 9_000 };
export const COMPANY_LOGO: LogoView = { url: `/api/branding/logos/company/${SHA_C}`, width: 256, height: 256, mime: 'image/jpeg', sizeBytes: 20_000 };

/** `GET /api/branding/default` when nothing is set. */
export const PUBLIC_UNSET: PublicBranding = { appTitle: NO_TEXT, signInMessage: NO_TEXT, footer: NO_TEXT, color: 'blue', appLogo: null };

/** A branded installation default (the dev seed's texts, plus a title, a colour and a logo). */
export const PUBLIC_BRANDED: PublicBranding = {
  appTitle: text3('Portail RH', 'بوابة الموارد البشرية', 'HR Portal'),
  signInMessage: text3('Environnement de démonstration : données fictives.', 'بيئة تجريبية: بيانات غير حقيقية.', 'Demonstration environment: fictitious data.'),
  footer: text3('Groupe Démo — assistance : support@demo.dz', 'مجموعة ديمو — الدعم: support@demo.dz', 'Groupe Démo — support: support@demo.dz'),
  color: 'teal',
  appLogo: { url: DEFAULT_LOGO.url, width: DEFAULT_LOGO.width, height: DEFAULT_LOGO.height },
};

/** `me.branding` of a company with its own title, colour, welcome texts and logos. */
export const EFFECTIVE_BRANDED: EffectiveBranding = {
  appTitle: text3('RH Groupe Démo', 'الموارد البشرية', 'Demo Group HR'),
  welcomeTitle: text3('Bonjour et bienvenue', 'مرحبًا بكم'),
  welcomeMessage: text3('Retrouvez ici vos tâches, vos congés et votre pointage.', 'تجدون هنا المهام والعطل وتسجيل الحضور.'),
  footer: text3('Groupe Démo — assistance : support@demo.dz'),
  color: 'plum',
  appLogo: { url: APP_LOGO.url, width: APP_LOGO.width, height: APP_LOGO.height },
  companyLogo: { url: COMPANY_LOGO.url, width: COMPANY_LOGO.width, height: COMPANY_LOGO.height },
};

/** Markup typed into every text: it must stay text everywhere it is shown. */
export const MARKUP = '<img src=x onerror=alert(1)><script>alert(2)</script>';

export const LIMITS: BrandingSettingsView['limits'] = { appTitle: 40, welcomeTitle: 80, welcomeMessage: 500, signInMessage: 500, footer: 200, logoMaxBytes: 262144 };
export const PALETTE: BrandingSettingsView['palette'] = ['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate'];

/** `GET /api/branding/settings` for the owning company: an installation default, and a company that set little. */
export const SETTINGS_OWNER: BrandingSettingsView = {
  company: {
    appTitle: NO_TEXT,
    welcomeTitle: NO_TEXT,
    welcomeMessage: text3('Retrouvez ici vos tâches, vos congés et votre pointage.', 'تجدون هنا المهام والعطل وتسجيل الحضور.', 'Your tasks, leave and attendance in one place.'),
    footer: NO_TEXT,
    color: null,
    appLogo: null,
    companyLogo: COMPANY_LOGO,
    updatedAt: '2026-10-08T09:00:00Z',
  },
  installation: {
    appTitle: text3('Portail RH', 'بوابة الموارد البشرية', 'HR Portal'),
    signInMessage: text3('Environnement de démonstration : données fictives.'),
    footer: text3('Groupe Démo — assistance : support@demo.dz'),
    color: 'teal',
    appLogo: DEFAULT_LOGO,
    updatedAt: '2026-10-08T08:00:00Z',
  },
  inherited: {
    appTitle: text3('Portail RH', 'بوابة الموارد البشرية', 'HR Portal'),
    footer: text3('Groupe Démo — assistance : support@demo.dz'),
    color: 'teal',
    appLogo: { url: DEFAULT_LOGO.url, width: DEFAULT_LOGO.width, height: DEFAULT_LOGO.height },
  },
  palette: PALETTE,
  limits: LIMITS,
};

/** The same for a company that does not own the installation default. */
export const SETTINGS_OTHER: BrandingSettingsView = { ...SETTINGS_OWNER, installation: null };

/**
 * Answers every pending `GET /api/branding/default`: BrandingService reads it again after each sign-out (and at a
 * signed-out start-up), so specs that sign out answer it here instead of naming it in every test.
 */
export function answerBrandingDefault(http: HttpTestingController, body: PublicBranding = PUBLIC_UNSET): number {
  const pending = http.match(BRANDING_DEFAULT_URL).filter((req) => !req.cancelled);
  for (const req of pending) req.flush(body);
  return pending.length;
}
