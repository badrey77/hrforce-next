import { PgJobQueue } from '../../../platform/jobs/job-queue.js';
import type { Notifier } from '../../../platform/notifications/notifier.js';
import { NotificationRepository } from './notification.repository.js';
import { PgNotifier } from './pg-notifier.js';

/**
 * The Notifier for the worker's jobs (no Nest container there): the same implementation as the API's, writing in the
 * job's transaction (`inCompany`, src/worker/company-loop.ts) — rows, NOTIFY and e-mail jobs commit with it.
 * hrforce_worker holds INSERT on `notification` (migration 0023) and EXECUTE on `graphile_worker.add_job`.
 */
export function createWorkerNotifier(): Notifier {
  return new PgNotifier(new NotificationRepository(), new PgJobQueue());
}
