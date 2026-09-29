/**
 * Notification e-mails (docs/contracts/notifications.md › Rules): one per notification, in the recipient's locale,
 * plain text + simple HTML (dir="rtl" for Arabic). Privacy: who / what / when + a link — never balances or reasons
 * (a rejection's comment stays in the app). Pure: no Nest, no Kysely.
 */
import type { NotificationType } from '../../../platform/notifications/notifier.js';

export type MailLocale = 'fr' | 'ar' | 'en';

export interface NotificationMailInput {
  type: NotificationType;
  locale: MailLocale;
  recipientName: string;
  /**
   * the notification's data (employeeName, employeeNameAr, leaveType, startDate, endDate, days, actorName, …) and the
   * internal `audience`: `employee` (the recipient is the employee: "your request") or `requester` / `approver` (someone
   * else: the sentence names the employee). A missing audience counts as someone else — naming is never wrong.
   */
  data: Readonly<Record<string, unknown>>;
  /** the leave type's label in the recipient's locale (falls back to the code) */
  leaveTypeLabel: string | null;
  /** the document type's label in the recipient's locale (document notifications; falls back to the code) */
  documentTypeLabel?: string | null;
  /** absolute link (`${WEB_BASE_URL}` + the notification's path) */
  link: string;
}

export interface NotificationMail {
  subject: string;
  text: string;
  html: string;
}

interface Facts {
  /** the recipient is the employee the request is for */
  own: boolean;
  employee: string;
  type: string;
  start: string;
  end: string;
  days: string;
  actor: string;
  /** the subject is a self-service document request (task.assigned) */
  document: boolean;
  docType: string;
  number: string;
}

interface Wording {
  greeting: (name: string) => string;
  subjects: Record<NotificationType, (f: Facts) => string>;
  bodies: Record<NotificationType, (f: Facts) => string>;
  action: Record<NotificationType, string>;
  footer: string;
  signature: string;
  someone: string;
  daysUnit: (days: string) => string;
}

const WORDING: Record<MailLocale, Wording> = {
  fr: {
    greeting: (name) => `Bonjour ${name},`,
    subjects: {
      'task.assigned': (f) => (f.document ? `HRForce — demande ${deFr(f.docType)} à traiter : ${f.employee}` : `HRForce — demande de congé à traiter : ${f.employee}`),
      'task.escalated': (f) => (f.own ? 'HRForce — votre demande de congé est transmise aux RH' : `HRForce — demande de congé de ${f.employee} transmise aux RH`),
      'leave.approved': (f) => (f.own ? 'HRForce — votre demande de congé est approuvée' : `HRForce — demande de congé de ${f.employee} approuvée`),
      'leave.rejected': (f) => (f.own ? 'HRForce — votre demande de congé est refusée' : `HRForce — demande de congé de ${f.employee} refusée`),
      'leave.cancelled': (f) => `HRForce — demande de congé annulée : ${f.employee}`,
      'leave.submitted_on_behalf': () => 'HRForce — une demande de congé a été déposée pour vous',
      'document.ready': (f) => `HRForce — votre document est prêt (${f.docType})`,
      'document.rejected': () => 'HRForce — votre demande de document est refusée',
    },
    bodies: {
      'task.assigned': (f) =>
        f.document
          ? `La demande ${deFr(f.docType)} de ${f.employee} attend votre décision.`
          : `La demande de congé de ${f.employee} (${f.type}, du ${f.start} au ${f.end}, ${f.days}) attend votre décision.`,
      'task.escalated': (f) =>
        `L’étape du responsable hiérarchique n’a pas pu être attribuée pour ${f.own ? 'votre demande' : `la demande de ${f.employee}`} (${f.type}, du ${f.start} au ${f.end}) : elle est transmise directement aux ressources humaines.`,
      'leave.approved': (f) => `${f.own ? 'Votre demande de congé' : `La demande de congé de ${f.employee}`} (${f.type}, du ${f.start} au ${f.end}, ${f.days}) a été approuvée par ${f.actor}.`,
      'leave.rejected': (f) =>
        `${f.own ? 'Votre demande de congé' : `La demande de congé de ${f.employee}`} (${f.type}, du ${f.start} au ${f.end}) a été refusée par ${f.actor}. Le détail est dans l’application.`,
      'leave.cancelled': (f) => `${f.actor} a annulé la demande de congé de ${f.employee} (${f.type}, du ${f.start} au ${f.end}). Elle ne demande plus votre décision.`,
      'leave.submitted_on_behalf': (f) => `${f.actor} a déposé pour vous une demande de congé : ${f.type}, du ${f.start} au ${f.end} (${f.days}).`,
      'document.ready': (f) => `Votre demande a été approuvée par ${f.actor} : ${f.docType} n° ${f.number}. Vous pouvez la télécharger dans « Mes documents ».`,
      'document.rejected': (f) => `Votre demande (${f.docType}) a été refusée par ${f.actor}. Le détail est dans l’application.`,
    },
    action: {
      'task.assigned': 'Ouvrir la tâche',
      'task.escalated': 'Voir la demande',
      'leave.approved': 'Voir la demande',
      'leave.rejected': 'Voir la demande',
      'leave.cancelled': 'Ouvrir mes tâches',
      'leave.submitted_on_behalf': 'Voir la demande',
      'document.ready': 'Ouvrir mes documents',
      'document.rejected': 'Ouvrir mes documents',
    },
    footer: 'Vous pouvez choisir les notifications reçues par e-mail dans Paramètres › Notifications.',
    signature: 'L’équipe HRForce',
    someone: 'un gestionnaire',
    daysUnit: (days) => `${days} j`,
  },
  ar: {
    greeting: (name) => `مرحبًا ${name}،`,
    subjects: {
      'task.assigned': (f) => (f.document ? `HRForce — طلب ${f.docType} للمعالجة: ${f.employee}` : `HRForce — طلب عطلة في انتظار قرارك: ${f.employee}`),
      'task.escalated': (f) => (f.own ? 'HRForce — تمت إحالة طلب عطلتك إلى الموارد البشرية' : `HRForce — تمت إحالة طلب عطلة ${f.employee} إلى الموارد البشرية`),
      'leave.approved': (f) => (f.own ? 'HRForce — تمت الموافقة على طلب عطلتك' : `HRForce — تمت الموافقة على طلب عطلة ${f.employee}`),
      'leave.rejected': (f) => (f.own ? 'HRForce — تم رفض طلب عطلتك' : `HRForce — تم رفض طلب عطلة ${f.employee}`),
      'leave.cancelled': (f) => `HRForce — تم إلغاء طلب العطلة: ${f.employee}`,
      'leave.submitted_on_behalf': () => 'HRForce — تم تقديم طلب عطلة باسمك',
      'document.ready': (f) => `HRForce — وثيقتك جاهزة (${f.docType})`,
      'document.rejected': () => 'HRForce — تم رفض طلب وثيقتك',
    },
    bodies: {
      'task.assigned': (f) =>
        f.document
          ? `طلب ${f.docType} من ${f.employee} في انتظار قرارك.`
          : `طلب عطلة ${f.employee} (${f.type}، من ${f.start} إلى ${f.end}، ${f.days}) في انتظار قرارك.`,
      'task.escalated': (f) =>
        `تعذر إسناد خطوة المسؤول المباشر ${f.own ? 'لطلبك' : `لطلب ${f.employee}`} (${f.type}، من ${f.start} إلى ${f.end})، فأحيل مباشرة إلى الموارد البشرية.`,
      'leave.approved': (f) =>
        `تمت الموافقة على ${f.own ? 'طلب عطلتك' : `طلب عطلة ${f.employee}`} (${f.type}، من ${f.start} إلى ${f.end}، ${f.days}) من طرف ${f.actor}.`,
      'leave.rejected': (f) =>
        `تم رفض ${f.own ? 'طلب عطلتك' : `طلب عطلة ${f.employee}`} (${f.type}، من ${f.start} إلى ${f.end}) من طرف ${f.actor}. التفاصيل متاحة في التطبيق.`,
      'leave.cancelled': (f) => `تم إلغاء طلب عطلة ${f.employee} (${f.type}، من ${f.start} إلى ${f.end}) من طرف ${f.actor}. لم يعد الطلب في انتظار قرارك.`,
      'leave.submitted_on_behalf': (f) => `تم تقديم طلب عطلة باسمك من طرف ${f.actor}: ${f.type}، من ${f.start} إلى ${f.end} (${f.days}).`,
      'document.ready': (f) => `تمت الموافقة على طلبك من طرف ${f.actor}: ${f.docType} رقم ${f.number}. يمكنك تحميل الوثيقة من «وثائقي».`,
      'document.rejected': (f) => `تم رفض طلبك (${f.docType}) من طرف ${f.actor}. التفاصيل متاحة في التطبيق.`,
    },
    action: {
      'task.assigned': 'فتح المهمة',
      'task.escalated': 'عرض الطلب',
      'leave.approved': 'عرض الطلب',
      'leave.rejected': 'عرض الطلب',
      'leave.cancelled': 'فتح مهامي',
      'leave.submitted_on_behalf': 'عرض الطلب',
      'document.ready': 'فتح وثائقي',
      'document.rejected': 'فتح وثائقي',
    },
    footer: 'يمكنك اختيار الإشعارات التي تصلك بالبريد الإلكتروني من الإعدادات › الإشعارات.',
    signature: 'فريق HRForce',
    someone: 'أحد المسيّرين',
    daysUnit: arabicDays,
  },
  en: {
    greeting: (name) => `Hello ${name},`,
    subjects: {
      'task.assigned': (f) => (f.document ? `HRForce — ${f.docType} request awaiting your decision: ${f.employee}` : `HRForce — leave request awaiting your decision: ${f.employee}`),
      'task.escalated': (f) => (f.own ? 'HRForce — your leave request went straight to HR' : `HRForce — ${f.employee}’s leave request went straight to HR`),
      'leave.approved': (f) => (f.own ? 'HRForce — your leave request was approved' : `HRForce — ${f.employee}’s leave request approved`),
      'leave.rejected': (f) => (f.own ? 'HRForce — your leave request was rejected' : `HRForce — ${f.employee}’s leave request rejected`),
      'leave.cancelled': (f) => `HRForce — leave request cancelled: ${f.employee}`,
      'leave.submitted_on_behalf': () => 'HRForce — a leave request was filed for you',
      'document.ready': (f) => `HRForce — your document is ready (${f.docType})`,
      'document.rejected': () => 'HRForce — your document request was rejected',
    },
    bodies: {
      'task.assigned': (f) =>
        f.document
          ? `The ${f.docType} request of ${f.employee} is awaiting your decision.`
          : `The leave request of ${f.employee} (${f.type}, ${f.start} to ${f.end}, ${f.days}) is awaiting your decision.`,
      'task.escalated': (f) =>
        `The line-manager step could not be assigned for ${f.own ? 'your request' : `the request of ${f.employee}`} (${f.type}, ${f.start} to ${f.end}); it went straight to human resources.`,
      'leave.approved': (f) => `${f.own ? 'Your leave request' : `The leave request of ${f.employee}`} (${f.type}, ${f.start} to ${f.end}, ${f.days}) was approved by ${f.actor}.`,
      'leave.rejected': (f) =>
        `${f.own ? 'Your leave request' : `The leave request of ${f.employee}`} (${f.type}, ${f.start} to ${f.end}) was rejected by ${f.actor}. The details are in the app.`,
      'leave.cancelled': (f) => `${f.actor} cancelled the leave request of ${f.employee} (${f.type}, ${f.start} to ${f.end}). It no longer needs your decision.`,
      'leave.submitted_on_behalf': (f) => `${f.actor} filed a leave request for you: ${f.type}, ${f.start} to ${f.end} (${f.days}).`,
      'document.ready': (f) => `Your request was approved by ${f.actor}: ${f.docType} no. ${f.number}. You can download it from My documents.`,
      'document.rejected': (f) => `Your request (${f.docType}) was rejected by ${f.actor}. The details are in the app.`,
    },
    action: {
      'task.assigned': 'Open the task',
      'task.escalated': 'View the request',
      'leave.approved': 'View the request',
      'leave.rejected': 'View the request',
      'leave.cancelled': 'Open my tasks',
      'leave.submitted_on_behalf': 'View the request',
      'document.ready': 'Open my documents',
      'document.rejected': 'Open my documents',
    },
    footer: 'Choose which notifications you receive by e-mail in Settings › Notifications.',
    signature: 'The HRForce team',
    someone: 'a manager',
    daysUnit: (days) => `${days} day${days === '1' ? '' : 's'}`,
  },
};

/**
 * A day count in Arabic with the counted noun agreeing with the number (nominative): 1 → يوم واحد, 2 → يومان,
 * 3–10 → N أيام, 11–99 → N يومًا; from 100 on by the last two digits (00–02 → N يوم, 03–10 → N أيام, 11–99 → N يومًا).
 * Half days: 0.5 → نصف يوم, otherwise N يوم (2.5 يوم). Same rule as the titre de congé (assets/pdf/templates/titre_conge.typ).
 */
export function arabicDays(days: string): string {
  if (!/^\d+(\.\d+)?$/.test(days)) return `${days} يوم`.trim();
  if (days.includes('.')) return days === '0.5' ? 'نصف يوم' : `${days} يوم`;
  const n = Number(days);
  const tail = n % 100;
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (tail >= 3 && tail <= 10) return `${days} أيام`;
  if (tail >= 11) return `${days} يومًا`;
  return `${days} يوم`;
}

/** "de" + a French noun phrase, with elision: d’attestation de travail, de certificat de travail (label lower-cased). */
function deFr(label: string): string {
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return /^[aeiouyhéèêàâîô]/i.test(lower) ? `d’${lower}` : `de ${lower}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** 2026-10-12 → 12/10/2026 (fr, ar) or 2026-10-12 (en). */
export function formatDate(iso: string, locale: MailLocale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || locale === 'en') return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** 2.5 → "2,5" (fr), "2.5" otherwise. */
export function formatDays(days: unknown, locale: MailLocale): string {
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n)) return '';
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return locale === 'fr' ? text.replace('.', ',') : text;
}

export function renderNotificationMail(input: NotificationMailInput): NotificationMail {
  const w = WORDING[input.locale];
  const d = input.data;
  const employee = (input.locale === 'ar' && str(d['employeeNameAr'])) || str(d['employeeName']);
  const facts: Facts = {
    own: d['audience'] === 'employee',
    employee,
    type: input.leaveTypeLabel ?? str(d['leaveType']),
    start: formatDate(str(d['startDate']), input.locale),
    end: formatDate(str(d['endDate']), input.locale),
    days: w.daysUnit(formatDays(d['days'], input.locale)),
    actor: str(d['actorName']) || w.someone,
    document: d['subjectType'] === 'document_request',
    docType: input.documentTypeLabel ?? str(d['documentType']),
    number: str(d['number']),
  };
  const subject = w.subjects[input.type](facts);
  const body = w.bodies[input.type](facts);
  const action = w.action[input.type];
  const separator = input.locale === 'fr' ? ' : ' : ': ';
  const text = [w.greeting(input.recipientName), '', body, '', `${action}${separator}${input.link}`, '', w.footer, '', w.signature].join('\n');
  const dir = input.locale === 'ar' ? 'rtl' : 'ltr';
  const html = [
    `<!doctype html><html lang="${input.locale}" dir="${dir}"><body style="font-family: sans-serif; line-height: 1.5">`,
    `<p>${escapeHtml(w.greeting(input.recipientName))}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(action)}</a></p>`,
    `<p style="color: #555">${escapeHtml(w.footer)}</p>`,
    `<p>${escapeHtml(w.signature)}</p>`,
    '</body></html>',
  ].join('\n');
  return { subject, text, html };
}
