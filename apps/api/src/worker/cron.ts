import { parseCronItems, type CronItem, type ParsedCronItem } from 'graphile-worker';
import { TASKS } from './tasks.js';

const HOUR = 3_600_000;

/**
 * The cron (docs/contracts/notifications.md › Worker), in the worker process's time zone (UTC in the containers).
 * Graphile schedules each tick exactly once across all workers (known_crontabs) and backfills ticks missed while no
 * worker ran, within `backfillPeriod` — every task here is idempotent.
 */
export const CRON_ITEMS: readonly CronItem[] = [
  { task: TASKS.ensurePartitions, identifier: TASKS.ensurePartitions, match: '10 0 1 * *', options: { backfillPeriod: 7 * 24 * HOUR, maxAttempts: 10 } },
  { task: TASKS.accruals, identifier: TASKS.accruals, match: '0 1 1 * *', options: { backfillPeriod: 7 * 24 * HOUR, maxAttempts: 10 } },
  { task: TASKS.authCleanup, identifier: TASKS.authCleanup, match: '0 3 * * *', options: { backfillPeriod: 12 * HOUR, maxAttempts: 5 } },
  { task: TASKS.notificationsCleanup, identifier: TASKS.notificationsCleanup, match: '30 3 * * *', options: { backfillPeriod: 12 * HOUR, maxAttempts: 5 } },
];

export function parsedCronItems(): ParsedCronItem[] {
  return parseCronItems([...CRON_ITEMS]);
}
