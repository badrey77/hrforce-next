import { requireContext, type RequestContext } from './request-context.js';

const memos = new WeakMap<RequestContext, Map<string, Promise<unknown>>>();

/**
 * Computes `compute()` at most once per request (per RequestContext) and key; later calls in the same request get
 * the same promise. Used for per-request caches such as the caller's effective grants. A rejected computation is not
 * cached. The cache dies with the request (WeakMap keyed by the context object).
 */
export function requestMemo<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const context = requireContext();
  let memo = memos.get(context);
  if (!memo) {
    memo = new Map();
    memos.set(context, memo);
  }
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const created = compute();
  memo.set(key, created);
  created.catch(() => memo.delete(key));
  return created;
}
