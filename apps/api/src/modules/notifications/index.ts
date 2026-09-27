/** Public surface of the Notifications module (the only file other modules — and the worker — may import). */
export { NotificationsModule } from './notifications.module.js';
export type { NotificationPage, NotificationView, PreferenceView } from './application/notification-views.js';
export { EMAIL_DEFAULTS, linkOf, NOTIFICATION_TYPES } from './domain/notification-rules.js';
export { renderNotificationMail, type MailLocale, type NotificationMail } from './domain/mail-templates.js';
export { EMAIL_JOB } from './infra/pg-notifier.js';
export { LISTENER_APPLICATION_NAME, NotificationHub } from './infra/notification-hub.js';
export { NotificationStreams } from './application/notification-stream.js';
export {
  cleanupReadNotifications,
  parseEmailPayload,
  READ_NOTIFICATION_RETENTION_DAYS,
  sendNotificationEmail,
  type EmailJobDeps,
  type EmailJobPayload,
  type EmailOutcome,
  type MailPort,
} from './infra/notification-jobs.js';
