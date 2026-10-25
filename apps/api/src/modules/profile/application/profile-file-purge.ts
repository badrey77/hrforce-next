import type { Transaction } from 'kysely';
import type { AuditEvents } from '../../../platform/audit/audit-events.js';
import type { DB } from '../../../platform/db/schema.js';
import { purgeDue } from '../domain/profile.js';
import { purgeCandidates, purgeRequestFiles, retentionDays } from '../infra/profile.repository.js';

export interface ProfilePurgeResult {
  requests: number;
  files: number;
}

/**
 * The purge of one company's request files (worker cron `profile.files_purge`, daily; docs/contracts/profile-changes.md
 * › Notifications, worker), inside the worker's company transaction (hrforce_worker: UPDATE (content) on the files,
 * UPDATE (files_purged_at) on the requests): the bytes of rejected / cancelled requests decided more than the policy's
 * `file_retention_days` ago, and of approved ones once every file was copied into the employee file, are set to null;
 * the metadata stays and the request gets `files_purged_at`. One `profile.files_purged {requests, files}` event per
 * company that lost some. Idempotent: a marked request is never a candidate again.
 */
export async function runProfileFilePurge(tx: Transaction<DB>, companyId: string, now: Date, audit: AuditEvents): Promise<ProfilePurgeResult> {
  const days = await retentionDays(tx, companyId);
  const due = (await purgeCandidates(tx, companyId)).filter((c) => purgeDue({ status: c.status, decidedAt: c.decidedAt, copied: c.copied, retentionDays: days, now }));
  let files = 0;
  for (const request of due) files += await purgeRequestFiles(tx, companyId, request.id);
  if (due.length > 0) await audit.record({ type: 'profile.files_purged', subject: null, data: { requests: due.length, files } });
  return { requests: due.length, files };
}
