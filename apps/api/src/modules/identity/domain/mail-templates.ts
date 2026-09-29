import type { Locale, PasswordTokenPurpose } from './account.js';

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export interface PasswordMailInput {
  purpose: PasswordTokenPurpose;
  locale: Locale;
  displayName: string;
  link: string;
  /** validity of the link, in hours */
  validHours: number;
}

interface Wording {
  subject: Record<PasswordTokenPurpose, string>;
  greeting: (name: string) => string;
  intro: Record<PasswordTokenPurpose, string>;
  action: string;
  validity: (hours: number) => string;
  ignore: string;
  signature: string;
}

const WORDING: Record<Locale, Wording> = {
  fr: {
    subject: { setup: 'HRForce — créez votre mot de passe', reset: 'HRForce — réinitialisation de votre mot de passe' },
    greeting: (name) => `Bonjour ${name},`,
    intro: {
      setup: 'Un compte HRForce a été créé pour vous. Choisissez votre mot de passe pour l’activer :',
      reset: 'Une réinitialisation de votre mot de passe HRForce a été demandée. Choisissez un nouveau mot de passe :',
    },
    action: 'Choisir mon mot de passe',
    validity: (hours) => `Ce lien est valable ${hours} heure${hours > 1 ? 's' : ''} et ne peut servir qu’une fois.`,
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.',
    signature: 'L’équipe HRForce',
  },
  ar: {
    subject: { setup: 'HRForce — إنشاء كلمة المرور الخاصة بك', reset: 'HRForce — إعادة تعيين كلمة المرور' },
    greeting: (name) => `مرحبًا ${name}،`,
    intro: {
      setup: 'تم إنشاء حساب HRForce لك. يرجى اختيار كلمة المرور لتفعيله:',
      reset: 'تم طلب إعادة تعيين كلمة مرور حسابك في HRForce. يرجى اختيار كلمة مرور جديدة:',
    },
    action: 'اختيار كلمة المرور',
    validity: (hours) => `هذا الرابط صالح لمدة ${hours} ساعة ولا يمكن استخدامه إلا مرة واحدة.`,
    ignore: 'إذا لم يصدر هذا الطلب عنك، يمكنك تجاهل هذه الرسالة.',
    signature: 'فريق HRForce',
  },
  en: {
    subject: { setup: 'HRForce — choose your password', reset: 'HRForce — reset your password' },
    greeting: (name) => `Hello ${name},`,
    intro: {
      setup: 'An HRForce account has been created for you. Choose your password to activate it:',
      reset: 'A password reset was requested for your HRForce account. Choose a new password:',
    },
    action: 'Choose your password',
    validity: (hours) => `This link is valid for ${hours} hour${hours > 1 ? 's' : ''} and can be used once.`,
    ignore: 'If you did not request this, you can ignore this message.',
    signature: 'The HRForce team',
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Password setup / reset mail in the user's locale: plain text + simple HTML (dir="rtl" for Arabic). */
export function renderPasswordMail(input: PasswordMailInput): MailContent {
  const w = WORDING[input.locale];
  const lines = [w.greeting(input.displayName), '', w.intro[input.purpose], input.link, '', w.validity(input.validHours), w.ignore, '', w.signature];
  const dir = input.locale === 'ar' ? 'rtl' : 'ltr';
  const html = [
    `<!doctype html><html lang="${input.locale}" dir="${dir}"><body style="font-family: sans-serif; line-height: 1.5">`,
    `<p>${escapeHtml(w.greeting(input.displayName))}</p>`,
    `<p>${escapeHtml(w.intro[input.purpose])}</p>`,
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(w.action)}</a></p>`,
    `<p style="color: #555">${escapeHtml(w.validity(input.validHours))}<br>${escapeHtml(w.ignore)}</p>`,
    `<p>${escapeHtml(w.signature)}</p>`,
    '</body></html>',
  ].join('\n');
  return { subject: w.subject[input.purpose], text: lines.join('\n'), html };
}
