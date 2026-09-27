import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../context/request-context.js';

/**
 * Seam for background jobs (ADR 005, docs/contracts/notifications.md › Worker): modules enqueue a job for the worker
 * (`src/worker.ts`) without importing it. Transactional outbox: the job is written by `graphile_worker.add_job` in the
 * CURRENT request transaction — a rollback leaves no job, a commit makes it visible to the worker (LISTEN/NOTIFY).
 * hrforce_app holds EXECUTE on that SECURITY DEFINER function only (src/platform/db/worker-schema.ts).
 */
export interface EnqueueOptions {
  /** De-duplication key: a second job with the same key replaces the pending one. */
  jobKey?: string;
  /** Attempts before the job is given up (default 5; Graphile's exponential back-off between them). */
  maxAttempts?: number;
  /** Run no earlier than this instant (default: now). */
  runAt?: Date;
}

export abstract class JobQueue {
  /** Enqueues `task` with a JSON payload inside the current request transaction. */
  abstract enqueue(task: string, payload: Record<string, unknown>, options?: EnqueueOptions): Promise<void>;
}

const TASK = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

@Injectable()
export class PgJobQueue extends JobQueue {
  async enqueue(task: string, payload: Record<string, unknown>, options: EnqueueOptions = {}): Promise<void> {
    if (!TASK.test(task)) throw new Error(`invalid job task "${task}"`);
    await sql`select 1 from graphile_worker.add_job(
        ${task},
        payload => ${JSON.stringify(payload)}::json,
        run_at => ${options.runAt ?? null}::timestamptz,
        max_attempts => ${options.maxAttempts ?? 5}::int,
        job_key => ${options.jobKey ?? null}::text)`.execute(currentTx());
  }
}
