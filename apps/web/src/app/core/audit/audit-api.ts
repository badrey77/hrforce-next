/**
 * AuditApi — the one place that knows the Audit endpoint (`docs/contracts/audit.md` › Endpoint):
 * `GET /api/audit/timeline?subject=<type>:<id>&before=<cursor>&limit=50` (permission `audit.read`).
 *
 * Same split as core/org/org-api.ts (read that header first): a one-shot Observable (`timeline()`) and a
 * signal-driven `httpResource` (`timelineResource()`), used by `shared/timeline/timeline.ts`.
 *
 * Angular concepts:
 * - **Cursor pagination as request params.** The first page has no cursor: `before` is LEFT OUT (not sent as an
 *   empty string or `"null"`, which the API would try to parse). Each later page sends the previous page's
 *   `nextCursor` back as `before`. The cursor is opaque — the web never builds or parses one.
 * - **One resource, many pages.** `timelineResource()` is keyed on `{ subject, cursor }`: setting a new cursor
 *   re-runs the request function, which is how "load more" asks for the next page. A resource only ever holds the
 *   LAST response, so accumulating pages is the caller's job (see the Timeline component's header for why that
 *   design, and the alternatives).
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { type AuditSubject, TIMELINE_PAGE_SIZE, type TimelinePage } from './audit.models';

export const AUDIT_API_BASE = '/api/audit';

/** What one timeline request needs. `cursor: null` = the newest page. */
export interface TimelineRequest {
  readonly subject: AuditSubject;
  readonly cursor: string | null;
  readonly limit?: number;
}

/** Query params of one timeline request; `before` only when there is a cursor. */
export function timelineParams(request: TimelineRequest): Record<string, string> {
  const params: Record<string, string> = {
    subject: request.subject,
    limit: String(request.limit ?? TIMELINE_PAGE_SIZE),
  };
  if (request.cursor) params['before'] = request.cursor;
  return params;
}

@Injectable({ providedIn: 'root' })
export class AuditApi {
  private readonly http = inject(HttpClient);

  /** One page as an Observable (nothing is sent until someone subscribes). */
  timeline(subject: AuditSubject, cursor: string | null = null): Observable<TimelinePage> {
    return this.http.get<TimelinePage>(`${AUDIT_API_BASE}/timeline`, { params: timelineParams({ subject, cursor }) });
  }

  /**
   * One page as a resource. `request()` returning `undefined` sends nothing (status `idle`) — e.g. no subject yet.
   * Call from an injection context (a component field initializer).
   */
  timelineResource(request: () => TimelineRequest | undefined): HttpResourceRef<TimelinePage | undefined> {
    return httpResource<TimelinePage>(() => {
      const value = request();
      return value ? { url: `${AUDIT_API_BASE}/timeline`, params: timelineParams(value) } : undefined;
    });
  }
}
