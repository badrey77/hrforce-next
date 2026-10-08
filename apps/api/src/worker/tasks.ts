import { sql } from 'kysely';
import type { JobHelpers, TaskList } from 'graphile-worker';
import type { Logger } from 'pino';
import { algiersDate, runAttendanceRetention } from '../modules/attendance/index.js';
import { PgAuditEvents } from '../modules/audit/index.js';
import { algiersToday, runEmployeeFileRetention } from '../modules/documents/index.js';
import { runAccruals } from '../modules/leave/index.js';
import { recruitmentAlgiersDate, runRecruitmentRetention } from '../modules/recruitment/index.js';
import { cleanupReadNotifications, EMAIL_JOB, parseEmailPayload, sendNotificationEmail, type MailPort } from '../modules/notifications/index.js';
import { runOidcCleanup } from '../modules/sso/index.js';
import type { Database } from '../platform/db/database.js';
import { forEachCompany, inCompany } from './company-loop.js';

/**
 * The worker's task list (docs/contracts/notifications.md › Worker). Each task is a plain function of its
 * dependencies, payload and job identity (the tests call them directly); {@link buildTaskList} wraps them for Graphile
 * Worker with one structured log line per run (`job done` / `job failed`: task, jobId, attempt, durationMs, result).
 */
export interface WorkerDeps {
  /** Kysely over the hrforce_worker role (RLS applies: tenant work goes through inCompany / forEachCompany). */
  db: Database;
  logger: Logger;
  mail: MailPort;
  /** WEB_BASE_URL (links in e-mails) */
  webBaseUrl: string;
}

export interface JobInfo {
  id: string;
  attempt: number;
}

export const TASKS = {
  email: EMAIL_JOB,
  ensurePartitions: 'audit.ensure_partitions',
  accruals: 'leave.accruals',
  authCleanup: 'auth.cleanup',
  notificationsCleanup: 'notifications.cleanup',
  employeeFilesRetention: 'employee_files.retention',
  attendanceRetention: 'attendance.retention',
  oidcCleanup: 'oidc.cleanup',
  recruitmentRetention: 'recruitment.retention',
} as const;

const requestIdOf = (task: string, job: JobInfo) => `job:${task}:${job.id}`;

/** `notifications.email` — one notification's e-mail (preference and account re-checked at send time). */
export async function emailTask(deps: WorkerDeps, payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const p = parseEmailPayload(payload);
  const outcome = await inCompany(deps.db, p.companyId, requestIdOf(TASKS.email, job), (tx) => sendNotificationEmail(tx, deps, p));
  return { notificationId: p.notificationId, companyId: p.companyId, outcome };
}

/** `audit.ensure_partitions` (monthly) — the current month + 12 ahead (idempotent; SECURITY DEFINER function). */
export async function ensurePartitionsTask(deps: WorkerDeps): Promise<Record<string, unknown>> {
  const { rows } = await sql<{ created: number }>`select audit.ensure_partitions(12) as created`.execute(deps.db);
  return { created: rows[0]?.created ?? 0 };
}

/**
 * The month `leave.accruals` accrues, as its first day: `payload.month` (YYYY-MM, a manual run) or the month BEFORE the
 * cron tick (`payload._cron.ts`, so a backfilled run accrues the right month), else the month before now (UTC).
 */
export function accrualMonth(payload: unknown, now = new Date()): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const month = p['month'];
  if (typeof month === 'string') {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!m) throw new Error('leave.accruals: payload.month must be YYYY-MM');
    return `${m[1]}-${m[2]}-01`;
  }
  // Graphile's cron payload: {_cron: {ts: <ISO tick>, backfilled?}}
  const ts = ((p['_cron'] ?? {}) as Record<string, unknown>)['ts'];
  const tick = typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : now;
  const previous = new Date(Date.UTC(tick.getUTCFullYear(), tick.getUTCMonth() - 1, 1));
  return previous.toISOString().slice(0, 10);
}

/** `leave.accruals` (monthly) — the previous month's accruals, company by company (idempotent per employee/month). */
export async function accrualsTask(deps: WorkerDeps, payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const month = accrualMonth(payload);
  const results = await forEachCompany(deps.db, requestIdOf(TASKS.accruals, job), (tx, companyId) =>
    runAccruals(tx, companyId, month, { employmentIds: null, actorUserId: null }),
  );
  return {
    month: month.slice(0, 7),
    companies: results.length,
    created: results.reduce((n, r) => n + (r.result?.created ?? 0), 0),
    alreadyAccrued: results.reduce((n, r) => n + (r.result?.alreadyAccrued ?? 0), 0),
  };
}

/** `auth.cleanup` (daily) — login events > 180 days, used/expired password tokens > 30 days (definer functions). */
export async function authCleanupTask(deps: WorkerDeps): Promise<Record<string, unknown>> {
  const { rows } = await sql<{ loginEvents: number; passwordTokens: number }>`
    select auth.cleanup_login_events() as "loginEvents", auth.cleanup_password_tokens() as "passwordTokens"`.execute(deps.db);
  return { loginEvents: rows[0]?.loginEvents ?? 0, passwordTokens: rows[0]?.passwordTokens ?? 0 };
}

/** `notifications.cleanup` (daily) — notifications read more than 90 days ago, company by company. */
export async function notificationsCleanupTask(deps: WorkerDeps, _payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const results = await forEachCompany(deps.db, requestIdOf(TASKS.notificationsCleanup, job), (tx, companyId) => cleanupReadNotifications(tx, companyId));
  return { companies: results.length, deleted: results.reduce((n, r) => n + (r.result ?? 0), 0) };
}

/**
 * `employee_files.retention` (monthly) — company by company, removes the bytes of employee files whose category's
 * retention after the end has passed (docs/contracts/documents.md › Audit, retention, worker); `payload.today`
 * (YYYY-MM-DD) overrides the Algiers date for a manual run or a test.
 */
export async function employeeFilesRetentionTask(deps: WorkerDeps, payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const given = p['today'];
  if (given !== undefined && (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given))) throw new Error('employee_files.retention: payload.today must be YYYY-MM-DD');
  const today = typeof given === 'string' ? given : algiersToday();
  const audit = new PgAuditEvents(deps.db);
  const results = await forEachCompany(deps.db, requestIdOf(TASKS.employeeFilesRetention, job), (tx, companyId) => runEmployeeFileRetention(tx, companyId, today, audit));
  return { today, companies: results.length, purged: results.reduce((n, r) => n + (r.result?.purged ?? 0), 0) };
}

/**
 * `attendance.retention` (monthly) — company by company, deletes the punches older than the policy's retention
 * (docs/contracts/attendance.md › Retention and worker) and records one `attendance.purged` event per company that
 * lost some; `payload.today` (YYYY-MM-DD) overrides the Algiers date for a manual run or a test.
 */
export async function attendanceRetentionTask(deps: WorkerDeps, payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const given = p['today'];
  if (given !== undefined && (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given))) throw new Error('attendance.retention: payload.today must be YYYY-MM-DD');
  const today = typeof given === 'string' ? given : algiersDate(Date.now());
  const audit = new PgAuditEvents(deps.db);
  const results = await forEachCompany(deps.db, requestIdOf(TASKS.attendanceRetention, job), (tx, companyId) => runAttendanceRetention(tx, companyId, today, audit));
  return { today, companies: results.length, punches: results.reduce((n, r) => n + (r.result?.punches ?? 0), 0), corrections: results.reduce((n, r) => n + (r.result?.corrections ?? 0), 0) };
}

/**
 * `oidc.cleanup` (daily) — the OpenID Connect provider's expired rows (> 1 day) and old client-authentication failures
 * (docs/contracts/sso.md › Worker); global, not per company. `payload.now` (ISO instant) pins the clock (tests).
 */
export async function oidcCleanupTask(deps: WorkerDeps, payload: unknown): Promise<Record<string, unknown>> {
  const given = ((payload ?? {}) as Record<string, unknown>)['now'];
  if (given !== undefined && (typeof given !== 'string' || Number.isNaN(Date.parse(given)))) throw new Error('oidc.cleanup: payload.now must be an ISO instant');
  const result = await runOidcCleanup(deps.db, typeof given === 'string' ? new Date(given) : new Date());
  return { ...result };
}

/**
 * `recruitment.retention` (monthly) — company by company, purges the applications decided more than the policy's
 * retention months ago and the candidates left without any (docs/contracts/recruitment.md › Retention, erasure and
 * worker), and records one `recruitment.purged` event per company that lost some; `payload.today` (YYYY-MM-DD)
 * overrides the Algiers date for a manual run or a test.
 */
export async function recruitmentRetentionTask(deps: WorkerDeps, payload: unknown, job: JobInfo): Promise<Record<string, unknown>> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const given = p['today'];
  if (given !== undefined && (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given))) throw new Error('recruitment.retention: payload.today must be YYYY-MM-DD');
  const today = typeof given === 'string' ? given : recruitmentAlgiersDate(Date.now());
  const audit = new PgAuditEvents(deps.db);
  const results = await forEachCompany(deps.db, requestIdOf(TASKS.recruitmentRetention, job), (tx, companyId) => runRecruitmentRetention(tx, companyId, today, audit));
  const sum = (pick: (r: { applications: number; candidates: number; files: number }) => number) => results.reduce((n, r) => n + (r.result ? pick(r.result) : 0), 0);
  return { today, companies: results.length, applications: sum((r) => r.applications), candidates: sum((r) => r.candidates), files: sum((r) => r.files) };
}

type TaskFn = (deps: WorkerDeps, payload: unknown, job: JobInfo) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, TaskFn> = {
  [TASKS.email]: emailTask,
  [TASKS.ensurePartitions]: (deps) => ensurePartitionsTask(deps),
  [TASKS.accruals]: accrualsTask,
  [TASKS.authCleanup]: (deps) => authCleanupTask(deps),
  [TASKS.notificationsCleanup]: notificationsCleanupTask,
  [TASKS.employeeFilesRetention]: employeeFilesRetentionTask,
  [TASKS.attendanceRetention]: attendanceRetentionTask,
  [TASKS.oidcCleanup]: oidcCleanupTask,
  [TASKS.recruitmentRetention]: recruitmentRetentionTask,
};

/** Graphile Worker task list: every handler with structured logging (a thrown error = a retry with back-off). */
export function buildTaskList(deps: WorkerDeps): TaskList {
  const list: TaskList = {};
  for (const [task, handler] of Object.entries(HANDLERS)) {
    list[task] = async (payload: unknown, helpers: JobHelpers) => {
      const job = { id: String(helpers.job.id), attempt: helpers.job.attempts };
      const started = Date.now();
      try {
        const result = await handler(deps, payload, job);
        deps.logger.info({ task, jobId: job.id, attempt: job.attempt, durationMs: Date.now() - started, ...result }, 'job done');
      } catch (error) {
        deps.logger.error(
          { task, jobId: job.id, attempt: job.attempt, maxAttempts: helpers.job.max_attempts, durationMs: Date.now() - started, err: error instanceof Error ? error.message : String(error) },
          'job failed',
        );
        throw error;
      }
    };
  }
  return list;
}
