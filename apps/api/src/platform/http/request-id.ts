import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Accept caller-supplied ids only if they are short and made of safe characters (log-injection safe). */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const requestIds = new WeakMap<IncomingMessage, string>();

/** Returns the request id assigned by {@link requestIdMiddleware}, assigning one lazily if needed. */
export function getRequestId(req: IncomingMessage): string {
  let id = requestIds.get(req);
  if (!id) {
    const incoming = req.headers['x-request-id'];
    id = typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    requestIds.set(req, id);
  }
  return id;
}

/** Express-compatible middleware: propagates X-Request-Id (in → out), generating one when absent/invalid. */
export function requestIdMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  res.setHeader(REQUEST_ID_HEADER, getRequestId(req));
  next();
}
