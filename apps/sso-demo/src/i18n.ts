/**
 * fr / ar wording of the demo (docs/contracts/sso.md › Demo sister app › Pages). Arabic is gender-neutral
 * (owner rule 2026-09-29): « يرجى + masdar », verbal nouns, passive — never a masculine imperative.
 */
export type Lang = 'fr' | 'ar';

export const LANGS: readonly Lang[] = ['fr', 'ar'];

export function isLang(value: unknown): value is Lang {
  return value === 'fr' || value === 'ar';
}

export function dirOf(lang: Lang): 'ltr' | 'rtl' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

export interface Strings {
  productLine: string;
  homeTitle: string;
  homeText: string;
  signIn: string;
  cancelled: string;
  welcome: (name: string) => string;
  email: string;
  company: string;
  matricule: string;
  unit: string;
  noEmployee: string;
  rolesHeading: (count: number) => string;
  noRole: string;
  claimsSummary: string;
  signOut: string;
  signedOut: string;
  errorTitle: string;
  error: (code: string) => string;
  backHome: string;
  switchTo: string;
  notFound: string;
}

export const STRINGS: Record<Lang, Strings> = {
  fr: {
    productLine: 'Démo SSO — application sœur fictive',
    homeTitle: 'Démo SSO',
    homeText: 'Application de démonstration connectée à HRForce.',
    signIn: 'Se connecter avec HRForce',
    cancelled: 'Connexion annulée.',
    welcome: (name) => `Bienvenue, ${name}`,
    email: 'Adresse e-mail',
    company: 'Entreprise',
    matricule: 'Matricule',
    unit: 'Unité',
    noEmployee: "Aucun dossier salarié n'est rattaché à ce compte.",
    rolesHeading: (count) => (count > 1 ? 'Rôles dans cette application' : 'Rôle dans cette application'),
    noRole: "Aucun rôle ne vous est attribué dans cette application. Demandez à l'administrateur des accès de HRForce.",
    claimsSummary: "Données reçues (jeton d'identité)",
    signOut: 'Se déconnecter',
    signedOut: 'Vous êtes déconnecté(e) de la démo et de HRForce.',
    errorTitle: 'Connexion impossible',
    error: (code) => `La connexion a échoué (${code}). Veuillez réessayer.`,
    backHome: "Retour à l'accueil",
    switchTo: 'العربية',
    notFound: 'Page introuvable.',
  },
  ar: {
    productLine: 'تطبيق تجريبي — تطبيق شقيق افتراضي',
    homeTitle: 'تطبيق تجريبي للدخول الموحد',
    homeText: 'تطبيق تجريبي مرتبط بـ HRForce.',
    signIn: 'تسجيل الدخول عبر HRForce',
    cancelled: 'تم إلغاء تسجيل الدخول.',
    welcome: (name) => `مرحبا، ${name}`,
    email: 'البريد الإلكتروني',
    company: 'المؤسسة',
    matricule: 'الرقم التعريفي',
    unit: 'الوحدة',
    noEmployee: 'لا يوجد ملف وظيفي مرتبط بهذا الحساب.',
    rolesHeading: (count) => (count > 1 ? 'الأدوار في هذا التطبيق' : 'الدور في هذا التطبيق'),
    noRole: 'لم يُسند أي دور لهذا الحساب في هذا التطبيق. يرجى التواصل مع مسؤول الصلاحيات في HRForce.',
    claimsSummary: 'البيانات المستلمة (رمز الهوية)',
    signOut: 'تسجيل الخروج',
    signedOut: 'تم تسجيل الخروج من التطبيق التجريبي ومن HRForce.',
    errorTitle: 'تعذّر تسجيل الدخول',
    error: (code) => `تعذّر تسجيل الدخول (${code}). يرجى إعادة المحاولة.`,
    backHome: 'العودة إلى الصفحة الرئيسية',
    switchTo: 'Français',
    notFound: 'الصفحة غير موجودة.',
  },
};

/** Labels of the app roles this demo knows (seeded in HRForce for the `sso-demo` client). */
const ROLE_LABELS: Record<string, Record<Lang, string>> = {
  operator: { fr: 'Opérateur', ar: 'التشغيل' },
  supervisor: { fr: 'Superviseur', ar: 'الإشراف' },
};

/** The label of an app role; an unknown code is shown as the code itself. */
export function roleLabel(code: string, lang: Lang): string {
  return Object.hasOwn(ROLE_LABELS, code) ? (ROLE_LABELS[code]?.[lang] ?? code) : code;
}
