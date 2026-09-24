import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema.js';

/** Per-request state, available anywhere below the request-context interceptor via AsyncLocalStorage. */
export interface RequestContext {
  readonly requestId: string;
  readonly userId: string | null;
  readonly companyId: string | null;
  /** The request's single transaction (null for routes marked @SkipTransaction()). */
  readonly tx: Transaction<DB> | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) throw new Error('No RequestContext: code is running outside a request / runInRequestTransaction()');
  return context;
}

/**
 * The current request transaction. Repositories MUST use this — never the root Kysely instance —
 * so that RLS (`app.company_id`) and audit (`app.user_id`, `app.request_id`) settings apply.
 */
export function currentTx(): Transaction<DB> {
  const { tx } = requireContext();
  if (!tx) throw new Error('No transaction in RequestContext (route is marked @SkipTransaction())');
  return tx;
}
