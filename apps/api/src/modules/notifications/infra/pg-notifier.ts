import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import { JobQueue } from '../../../platform/jobs/job-queue.js';
import { Notifier, type NotificationAudience, type NotifyInput } from '../../../platform/notifications/notifier.js';
import { NotificationRepository } from './notification.repository.js';

/** Job name of the e-mail of one notification (worker task list: src/worker/tasks.ts). */
export const EMAIL_JOB = 'notifications.email';

/**
 * The Notifier port (docs/contracts/notifications.md › Rules): recipients deduplicated, the actor removed (unless the
 * engine decided — task.escalated), one row per recipient (a repeated hook is a no-op thanks to notification_once_uk),
 * and one `notifications.email` job per NEW row, all in the request transaction. The row's insert trigger sends the
 * NOTIFY for the live stream; the e-mail job re-checks the preference and the account when it runs.
 */
@Injectable()
export class PgNotifier extends Notifier {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly jobs: JobQueue,
  ) {
    super();
  }

  async notify(input: NotifyInput): Promise<void> {
    const { companyId, userId: actor } = requireContext();
    if (!companyId) return;
    const recipients = new Map<string, NotificationAudience>();
    for (const r of input.recipients) {
      if (!r.userId || recipients.has(r.userId)) continue;
      if (r.userId === actor && !input.includeActor) continue;
      recipients.set(r.userId, r.audience);
    }
    for (const [userId, audience] of recipients) {
      const id = randomUUID();
      const created = await this.repo.insert(companyId, {
        id,
        userId,
        type: input.type,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        data: { ...input.data, audience },
      });
      if (created) await this.jobs.enqueue(EMAIL_JOB, { companyId, notificationId: id }, { jobKey: `${EMAIL_JOB}:${id}`, maxAttempts: 5 });
    }
  }
}
