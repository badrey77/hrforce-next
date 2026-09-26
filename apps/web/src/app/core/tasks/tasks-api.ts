/**
 * TasksApi — the "My tasks" endpoints of the workflow engine (docs/contracts/leave.md › Endpoints).
 * Same split as the other `*Api` services: a resource for the read, Observables for the two writes.
 *
 * `GET /tasks?status=open` is `@Authenticated` (no permission): every signed-in user may be a candidate — a unit head
 * with the `employe` role approves the manager step without holding any leave permission.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { TaskDecision, TaskList } from './tasks.models';

export const TASKS_API_BASE = '/api/tasks';

@Injectable({ providedIn: 'root' })
export class TasksApi {
  private readonly http = inject(HttpClient);

  /** Open tasks where the caller is a candidate. `enabled()` false (signed out) → no request. */
  openResource(enabled: () => boolean): HttpResourceRef<TaskList | undefined> {
    return httpResource<TaskList>(() => (enabled() ? { url: TASKS_API_BASE, params: { status: 'open' } } : undefined));
  }

  approve(id: string, body: TaskDecision = {}): Observable<unknown> {
    return this.http.post<unknown>(`${TASKS_API_BASE}/${encodeURIComponent(id)}/approve`, body);
  }

  reject(id: string, body: Required<TaskDecision>): Observable<unknown> {
    return this.http.post<unknown>(`${TASKS_API_BASE}/${encodeURIComponent(id)}/reject`, body);
  }
}
