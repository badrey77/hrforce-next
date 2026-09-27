import type { Request } from 'express';
import { inetOrNull } from '../infra/identity.repository.js';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** The caller's IP (Express `trust proxy` applied) and user agent, for login_event rows and audit data. */
export function clientOf(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  return { ip: inetOrNull(req.ip ?? req.socket.remoteAddress), userAgent: typeof ua === 'string' ? ua : null };
}
