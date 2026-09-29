import type { Locale } from './account.js';
import type { MailContent } from './mail-templates.js';

/**
 * Security e-mails of the two-step sign-in (docs/contracts/mfa.md): a recovery code was used (N left), and an
 * administrator reset the user's two-step sign-in. Plain text + simple HTML, in the user's locale (dir="rtl" in Arabic).
 */
export type MfaMailInput =
  | { kind: 'recovery_used'; locale: Locale; displayName: string; codesLeft: number }
  | { kind: 'reset'; locale: Locale; displayName: string };

interface Wording {
  greeting: (name: string) => string;
  recoverySubject: string;
  recoveryBody: (left: number) => string;
  resetSubject: string;
  resetBody: string;
  notYou: string;
  signature: string;
}

const WORDING: Record<Locale, Wording> = {
  fr: {
    greeting: (name) => `Bonjour ${name},`,
    recoverySubject: 'HRForce — un code de récupération a été utilisé',
    recoveryBody: (left) =>
      `Un code de récupération vient d’être utilisé pour vous connecter à HRForce. Il vous reste ${left} code${left > 1 ? 's' : ''}. ` +
      'Générez-en de nouveaux depuis « Sécurité » si nécessaire.',
    resetSubject: 'HRForce — votre connexion en deux étapes a été réinitialisée',
    resetBody:
      'Un administrateur a réinitialisé votre connexion en deux étapes et fermé vos sessions. ' +
      'À votre prochaine connexion, configurez de nouveau votre application d’authentification.',
    notYou: 'Si vous n’êtes pas à l’origine de cette action, prévenez immédiatement votre administrateur.',
    signature: 'L’équipe HRForce',
  },
  ar: {
    greeting: (name) => `مرحبًا ${name}،`,
    recoverySubject: 'HRForce — تم استخدام رمز استرداد',
    recoveryBody: (left) => `تم للتو استخدام رمز استرداد لتسجيل الدخول إلى HRForce. تبقّى لديك ${left} من الرموز. يمكنك إنشاء رموز جديدة من صفحة «الأمان» عند الحاجة.`,
    resetSubject: 'HRForce — تمت إعادة تعيين التحقق بخطوتين',
    resetBody: 'قام أحد المسؤولين بإعادة تعيين التحقق بخطوتين لحسابك وإغلاق جلساتك. عند تسجيل الدخول القادم، يجب إعادة إعداد تطبيق المصادقة.',
    notYou: 'إذا لم يصدر هذا الإجراء عنك، يرجى إبلاغ مسؤولك فورًا.',
    signature: 'فريق HRForce',
  },
  en: {
    greeting: (name) => `Hello ${name},`,
    recoverySubject: 'HRForce — a recovery code was used',
    recoveryBody: (left) =>
      `A recovery code was just used to sign in to HRForce. You have ${left} code${left === 1 ? '' : 's'} left. Generate new ones from “Security” if needed.`,
    resetSubject: 'HRForce — your two-step sign-in was reset',
    resetBody: 'An administrator reset your two-step sign-in and closed your sessions. Set up your authenticator app again at your next sign-in.',
    notYou: 'If you did not expect this, tell your administrator immediately.',
    signature: 'The HRForce team',
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderMfaMail(input: MfaMailInput): MailContent {
  const w = WORDING[input.locale];
  const subject = input.kind === 'recovery_used' ? w.recoverySubject : w.resetSubject;
  const body = input.kind === 'recovery_used' ? w.recoveryBody(input.codesLeft) : w.resetBody;
  const paragraphs = [w.greeting(input.displayName), body, w.notYou, w.signature];
  const dir = input.locale === 'ar' ? 'rtl' : 'ltr';
  const html = [
    `<!doctype html><html lang="${input.locale}" dir="${dir}"><body style="font-family: sans-serif; line-height: 1.5">`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    '</body></html>',
  ].join('\n');
  return { subject, text: paragraphs.join('\n\n'), html };
}
