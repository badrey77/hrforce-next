import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { renderNotificationMail, type MailLocale } from '../domain/mail-templates.js';
import { emailDefault, isNotificationType, linkOf } from '../domain/notification-rules.js';

/**
 * Worker side of the Notifications module (run by src/worker.ts as hrforce_worker, inside a transaction that has set
 * app.company_id — RLS applies; the restrictive own-user policies target hrforce_app only, so the system actor reads
 * any notification of ITS company). Nothing here runs in the API.
 */

/** Outgoing mail (the Identity module's MailSender satisfies it). */
export interface MailPort {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export interface EmailJobDeps {
  mail: MailPort;
  /** WEB_BASE_URL (no trailing slash) */
  webBaseUrl: string;
}

export interface EmailJobPayload {
  companyId: string;
  notificationId: string;
}

export type EmailOutcome = 'sent' | 'missing' | 'preference-off' | 'recipient-inactive';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseEmailPayload(payload: unknown): EmailJobPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const companyId = p['companyId'];
  const notificationId = p['notificationId'];
  if (typeof companyId !== 'string' || !UUID.test(companyId) || typeof notificationId !== 'string' || !UUID.test(notificationId)) {
    throw new Error('notifications.email: payload must be {companyId, notificationId} (uuids)');
  }
  return { companyId, notificationId };
}

function locale(value: string | null | undefined): MailLocale {
  return value === 'ar' || value === 'en' ? value : 'fr';
}

/**
 * `notifications.email`: re-checks, AT SEND TIME, the recipient's preference for the type (absent row = default) and
 * account (not active or no longer a member → skipped), then renders the mail in the recipient's locale with the link
 * and sends it. A thrown error (SMTP down) makes Graphile retry the job.
 */
export async function sendNotificationEmail(tx: Transaction<DB>, deps: EmailJobDeps, payload: EmailJobPayload): Promise<EmailOutcome> {
  const n = await tx
    .selectFrom('notification')
    .select(['id', 'user_id', 'type', 'subject_type', 'subject_id', 'data'])
    .where('company_id', '=', payload.companyId)
    .where('id', '=', payload.notificationId)
    .executeTakeFirst();
  if (!n || !isNotificationType(n.type)) return 'missing';
  const pref = await tx
    .selectFrom('notification_preference')
    .select('email')
    .where('company_id', '=', payload.companyId)
    .where('user_id', '=', n.user_id)
    .where('type', '=', n.type)
    .executeTakeFirst();
  if (!(pref?.email ?? emailDefault(n.type))) return 'preference-off';
  const { rows } = await sql<{ email: string; display_name: string; locale: string; status: string }>`
    select email, display_name, locale, status from auth.notification_recipient(${n.user_id}::uuid)`.execute(tx);
  const recipient = rows[0];
  if (!recipient || recipient.status !== 'active') return 'recipient-inactive';
  const data = (n.data ?? {}) as Record<string, unknown>;
  const lang = locale(recipient.locale);
  let leaveTypeLabel: string | null = null;
  if (typeof data['leaveType'] === 'string') {
    const type = await tx
      .selectFrom('leave_type')
      .select(['name_fr', 'name_ar', 'name_en'])
      .where('company_id', '=', payload.companyId)
      .where('code', '=', data['leaveType'])
      .executeTakeFirst();
    if (type) leaveTypeLabel = lang === 'ar' ? type.name_ar : lang === 'en' ? type.name_en : type.name_fr;
  }
  const link = `${deps.webBaseUrl}${linkOf({ type: n.type, subjectType: n.subject_type, subjectId: n.subject_id, data })}`;
  const mail = renderNotificationMail({ type: n.type, locale: lang, recipientName: recipient.display_name, data, leaveTypeLabel, link });
  await deps.mail.send({ to: recipient.email, ...mail });
  return 'sent';
}

/** Retention of read notifications (contract › Cron `notifications.cleanup`). */
export const READ_NOTIFICATION_RETENTION_DAYS = 90;

/** `notifications.cleanup` for one company: deletes its notifications read more than 90 days ago → count. */
export async function cleanupReadNotifications(tx: Transaction<DB>, companyId: string): Promise<number> {
  const result = await tx
    .deleteFrom('notification')
    .where('company_id', '=', companyId)
    .where('read_at', '<', sql<Date>`now() - make_interval(days => ${READ_NOTIFICATION_RETENTION_DAYS})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
