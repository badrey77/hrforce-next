import { Global, Module } from '@nestjs/common';
import { Notifier } from '../../platform/notifications/notifier.js';
import { NotificationsController } from './api/notifications.controller.js';
import { NotificationStreams } from './application/notification-stream.js';
import { NotificationsService } from './application/notifications.service.js';
import { NotificationHub } from './infra/notification-hub.js';
import { NotificationRepository } from './infra/notification.repository.js';
import { PgNotifier } from './infra/pg-notifier.js';

/**
 * Notifications (docs/contracts/notifications.md): the in-app notifications of the caller, e-mail preferences, the
 * live SSE stream (one LISTEN connection per process) and the platform port {@link Notifier} (GLOBAL, so Workflow and
 * Leave create notifications without importing this module). E-mails are sent by the worker (src/worker.ts) through
 * the job `notifications.email` (infra/notification-jobs.ts, exported for the worker).
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationRepository, NotificationsService, NotificationHub, NotificationStreams, { provide: Notifier, useClass: PgNotifier }],
  exports: [Notifier],
})
export class NotificationsModule {}
