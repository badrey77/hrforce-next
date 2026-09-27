import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Client, type Notification as PgNotification } from 'pg';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { NOTIFICATION_CHANNEL } from './notification.repository.js';

/** A fan-out message: a new notification (`id`), or `id: null` = the recipient's counts changed (marked read). */
export interface HubMessage {
  id: string | null;
}

export type HubListener = (message: HubMessage) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECONNECT_MS = 1000;
/** application_name of the listener connection (one per API process — visible in pg_stat_activity). */
export const LISTENER_APPLICATION_NAME = 'hrforce-api-listen';

function parse(payload: string | undefined): { key: string; message: HubMessage } | null {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as { companyId?: unknown; userId?: unknown; id?: unknown };
    if (typeof value.companyId !== 'string' || typeof value.userId !== 'string' || !UUID.test(value.companyId) || !UUID.test(value.userId)) return null;
    const id = typeof value.id === 'string' && UUID.test(value.id) ? value.id : null;
    return { key: `${value.companyId}:${value.userId}`, message: { id } };
  } catch {
    return null;
  }
}

/**
 * Live fan-out for the SSE streams (docs/contracts/notifications.md › Live updates): ONE dedicated Postgres connection
 * per API process runs `LISTEN hrforce_notifications` (opened on the first subscriber, re-opened after a failure while
 * anyone listens) and dispatches each payload `{companyId, userId, id}` to that recipient's open streams in this
 * process. The payload carries ids only: each stream re-reads the row under RLS as its user before sending anything.
 * After a reconnect every subscriber gets `id: null` (refresh the count: NOTIFYs sent meanwhile were missed).
 */
@Injectable()
export class NotificationHub implements OnApplicationShutdown {
  private readonly logger = new Logger('NotificationHub');
  private readonly listeners = new Map<string, Set<HubListener>>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Registers `listener` for (company, user) and makes sure the LISTEN connection is up. Returns the unsubscribe. */
  async subscribe(companyId: string, userId: string, listener: HubListener): Promise<() => void> {
    const key = `${companyId}:${userId}`;
    const set = this.listeners.get(key) ?? new Set<HubListener>();
    set.add(listener);
    this.listeners.set(key, set);
    const unsubscribe = () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
    try {
      await this.ensureListening();
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  /** Number of open subscriptions (tests, diagnostics). */
  get size(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private ensureListening(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('notification hub is shut down'));
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.env.DATABASE_URL, application_name: LISTENER_APPLICATION_NAME });
    client.on('notification', (msg: PgNotification) => this.dispatch(msg.payload));
    client.on('error', (error: Error) => this.lost(client, error));
    client.on('end', () => this.lost(client, null));
    try {
      await client.connect();
      await client.query(`listen ${NOTIFICATION_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
  }

  private dispatch(payload: string | undefined): void {
    const parsed = parse(payload);
    if (!parsed) return;
    for (const listener of this.listeners.get(parsed.key) ?? []) listener(parsed.message);
  }

  private lost(client: Client, error: Error | null): void {
    if (this.client !== client) return;
    this.client = null;
    client.end().catch(() => undefined);
    if (this.closed) return;
    this.logger.warn({ err: error?.message }, 'notification listener connection lost');
    this.scheduleReconnect();
  }

  /** While anyone listens: reconnect after RECONNECT_MS, then tell every stream to refresh its count. */
  private scheduleReconnect(): void {
    if (this.closed || this.listeners.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.listeners.size === 0) return;
      this.ensureListening().then(
        () => {
          for (const set of this.listeners.values()) for (const listener of set) listener({ id: null });
        },
        (e: unknown) => {
          this.logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'notification listener reconnect failed');
          this.scheduleReconnect();
        },
      );
    }, RECONNECT_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listeners.clear();
    const client = this.client;
    this.client = null;
    await this.connecting?.catch(() => undefined);
    await client?.end().catch(() => undefined);
  }
}
