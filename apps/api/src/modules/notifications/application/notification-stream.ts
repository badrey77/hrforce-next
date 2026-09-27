import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { Request, Response } from 'express';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { NotificationHub, type HubMessage } from '../infra/notification-hub.js';
import { NotificationRepository } from '../infra/notification.repository.js';
import { toView } from './notifications.service.js';

/** Keep-alive comment interval (proxies and browsers drop idle connections). */
export const PING_INTERVAL_MS = 25_000;
/** A stream never outlives this, even for an identity without a known expiry (DEV_AUTH headers). */
export const MAX_STREAM_MS = 15 * 60_000;

export interface StreamIdentity {
  requestId: string;
  companyId: string;
  userId: string;
  /** access-token expiry, seconds since epoch (null: unknown → MAX_STREAM_MS) */
  expiresAt: number | null;
}

interface OpenStream {
  close(): void;
}

/**
 * `GET /api/me/notifications/stream` (docs/contracts/notifications.md › Live updates), Server-Sent Events:
 *   event `unread` {count}          on open, and whenever the count changes (new notification, marked read elsewhere)
 *   event `notification` <NotificationView>   each new notification of the caller
 *   `: ping` comment every 25 s
 * The stream holds NO database transaction: each hub message (ids only) is re-read in its own short transaction as the
 * caller (app.company_id + app.user_id → RLS, restrictive own-user policy), so a payload can never leak someone else's
 * row. It closes itself when the access token behind it expires (≤ 15 min); the client refreshes its session with an
 * ordinary call and reconnects. Headers disable proxy buffering (X-Accel-Buffering for Nginx; Caddy flushes
 * text/event-stream by itself).
 */
@Injectable()
export class NotificationStreams implements BeforeApplicationShutdown {
  private readonly logger = new Logger('NotificationStreams');
  private readonly open = new Set<OpenStream>();

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly hub: NotificationHub,
    private readonly repo: NotificationRepository,
  ) {}

  get openCount(): number {
    return this.open.size;
  }

  async start(req: Request, res: Response, who: StreamIdentity): Promise<void> {
    const lifetime = Math.min(MAX_STREAM_MS, who.expiresAt === null ? MAX_STREAM_MS : who.expiresAt * 1000 - Date.now());
    let closed = false;
    let chain: Promise<void> = Promise.resolve();
    let unsubscribe: (() => void) | null = null;
    const timers: NodeJS.Timeout[] = [];

    const stream: OpenStream = {
      close: () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearTimeout(t);
        unsubscribe?.();
        this.open.delete(stream);
        if (!res.writableEnded) res.end();
      },
    };
    const write = (chunk: string) => {
      if (!closed && !res.writableEnded) res.write(chunk);
    };
    const event = (name: string, data: unknown) => write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    /** Serialised per stream: events keep their order. A failed re-read is logged, the stream stays open. */
    const enqueue = (work: () => Promise<void>) => {
      chain = chain.then(work).catch((error: unknown) => {
        this.logger.warn({ err: error instanceof Error ? error.message : String(error), requestId: who.requestId }, 'notification stream read failed');
      });
    };
    const asCaller = <T>(fn: () => Promise<T>) =>
      runInRequestTransaction(this.db, { requestId: who.requestId, companyId: who.companyId, userId: who.userId }, fn);
    const sendCount = async () => {
      const count = await asCaller(() => this.repo.unreadCount(who.companyId, who.userId));
      event('unread', { count });
    };
    const onMessage = (message: HubMessage) =>
      enqueue(async () => {
        if (closed) return;
        if (message.id) {
          const id = message.id;
          const row = await asCaller(() => this.repo.one(who.companyId, who.userId, id));
          if (row) event('notification', toView(row));
        }
        await sendCount();
      });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    this.open.add(stream);
    req.on('close', () => stream.close());
    res.on('error', () => stream.close());

    write('retry: 5000\n\n');
    if (lifetime <= 0) {
      stream.close();
      return;
    }
    timers.push(setTimeout(() => stream.close(), lifetime));
    const ping = setInterval(() => write(': ping\n\n'), PING_INTERVAL_MS);
    timers.push(ping);
    try {
      const off = await this.hub.subscribe(who.companyId, who.userId, onMessage);
      if (closed) off();
      else unsubscribe = off;
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'notification stream: listener unavailable');
      stream.close();
      return;
    }
    enqueue(sendCount);
  }

  /** Ends every open stream before the HTTP server closes (it waits for open connections otherwise). */
  beforeApplicationShutdown(): void {
    // (close() removes the stream from the set: deleting the current element while iterating a Set is safe)
    for (const stream of this.open) stream.close();
  }
}
