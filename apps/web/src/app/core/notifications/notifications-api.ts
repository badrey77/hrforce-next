/**
 * NotificationsApi — the one place that knows the notification endpoints (`docs/contracts/notifications.md` ›
 * Endpoints). Same split as the other `*Api` services (core/org/org-api.ts explains it): reads that a page shows are
 * `httpResource`s, writes and the reads a SERVICE needs at a moment of its choosing are one-shot Observables.
 *
 * Angular concepts:
 * - **Cursor params built by a pure function** (`notificationListParams`), like the audit timeline: `before` and
 *   `unreadOnly` are LEFT OUT when they do not apply (never `before=null`), `limit` is always sent.
 * - **Why the stream is NOT here.** `GET /me/notifications/stream` is Server-Sent Events: it is read with the browser's
 *   `EventSource`, not `HttpClient` (see notification-center.ts for why, and what that costs). This file only exports
 *   its URL.
 * - **`preferences()` normalises the body.** The contract answers a bare array; `toPreferences()` also accepts
 *   `{items: [...]}` so a harmless shape change on the API side does not blank the settings page.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  NotificationPage,
  NotificationPreference,
  NotificationPreferenceInput,
  NotificationQuery,
  UnreadCount,
} from './notifications.models';

export const NOTIFICATIONS_API_BASE = '/api/me/notifications';
export const PREFERENCES_URL = '/api/me/notification-preferences';
/** SSE endpoint, opened by `NotificationCenter` through `EVENT_SOURCE_FACTORY`. */
export const NOTIFICATIONS_STREAM_URL = `${NOTIFICATIONS_API_BASE}/stream`;

/** Query params of `GET /me/notifications`. */
export function notificationListParams(query: NotificationQuery): Record<string, string> {
  const params: Record<string, string> = { limit: String(query.limit) };
  if (query.unreadOnly) params['unreadOnly'] = 'true';
  if (query.cursor) params['before'] = query.cursor;
  return params;
}

/** The preferences body as a list, whether the API sent `[...]` (contract) or `{items: [...]}`. */
export function toPreferences(body: unknown): NotificationPreference[] {
  if (Array.isArray(body)) return body as NotificationPreference[];
  if (typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)) {
    return (body as { items: NotificationPreference[] }).items;
  }
  return [];
}

const enc = encodeURIComponent;

@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly http = inject(HttpClient);

  /** One page as an Observable (the bell's "latest 10"). */
  list(query: NotificationQuery): Observable<NotificationPage> {
    return this.http.get<NotificationPage>(NOTIFICATIONS_API_BASE, { params: notificationListParams(query) });
  }

  /** One page as a resource (the /notifications page); `undefined` → idle. Call from an injection context. */
  listResource(query: () => NotificationQuery | undefined): HttpResourceRef<NotificationPage | undefined> {
    return httpResource<NotificationPage>(() => {
      const value = query();
      return value ? { url: NOTIFICATIONS_API_BASE, params: notificationListParams(value) } : undefined;
    });
  }

  unreadCount(): Observable<UnreadCount> {
    return this.http.get<UnreadCount>(`${NOTIFICATIONS_API_BASE}/unread-count`);
  }

  /** 204; 404 if the notification is not the caller's. */
  markRead(id: string): Observable<void> {
    return this.http.post<void>(`${NOTIFICATIONS_API_BASE}/${enc(id)}/read`, {});
  }

  markAllRead(): Observable<void> {
    return this.http.post<void>(`${NOTIFICATIONS_API_BASE}/read-all`, {});
  }

  /** `GET /me/notification-preferences` as a resource, parsed by `toPreferences()`. */
  preferencesResource(): HttpResourceRef<NotificationPreference[] | undefined> {
    return httpResource<NotificationPreference[]>(() => PREFERENCES_URL, { parse: toPreferences });
  }

  savePreferences(body: readonly NotificationPreferenceInput[]): Observable<unknown> {
    return this.http.put<unknown>(PREFERENCES_URL, body);
  }
}
