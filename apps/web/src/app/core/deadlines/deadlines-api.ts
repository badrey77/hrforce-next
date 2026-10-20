/**
 * DeadlinesApi — the deadlines board, its summary, acks, the policy, and the contract-decision endpoints the task
 * panel uses (docs/contracts/contracts-deadlines.md › Deadlines, Contract decisions). Reads are `httpResource`s
 * (create them from a field initializer), writes one-shot Observables.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ContractDecisionView,
  DeadlineItem,
  DeadlinePage,
  DeadlinePolicyView,
  DeadlineQuery,
  DeadlineSummary,
  NewDeadlineAck,
  ProposalBody,
} from './deadlines.models';

export const DEADLINES_API_BASE = '/api/deadlines';
export const CONTRACT_DECISIONS_API_BASE = '/api/contract-decisions';

const enc = encodeURIComponent;

/** Query params of `GET /deadlines`: empty filters left out, `status`, `within` and paging always sent. */
export function deadlineListParams(query: DeadlineQuery): Record<string, string> {
  const params: Record<string, string> = {};
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.kind) params['kind'] = query.kind;
  params['status'] = query.status;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  params['within'] = String(query.within);
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

@Injectable({ providedIn: 'root' })
export class DeadlinesApi {
  private readonly http = inject(HttpClient);

  listResource(query: () => DeadlineQuery | undefined): HttpResourceRef<DeadlinePage | undefined> {
    return httpResource<DeadlinePage>(() => {
      const value = query();
      return value ? { url: DEADLINES_API_BASE, params: deadlineListParams(value) } : undefined;
    });
  }

  /** `GET /deadlines/summary` (`deadline.read`). `enabled` false → no request. */
  summaryResource(enabled: () => boolean): HttpResourceRef<DeadlineSummary | undefined> {
    return httpResource<DeadlineSummary>(() => (enabled() ? `${DEADLINES_API_BASE}/summary` : undefined));
  }

  ack(body: NewDeadlineAck): Observable<DeadlineItem> {
    return this.http.post<DeadlineItem>(`${DEADLINES_API_BASE}/acks`, body);
  }

  unack(ackId: string): Observable<void> {
    return this.http.delete<void>(`${DEADLINES_API_BASE}/acks/${enc(ackId)}`);
  }

  policyResource(): HttpResourceRef<DeadlinePolicyView | undefined> {
    return httpResource<DeadlinePolicyView>(() => `${DEADLINES_API_BASE}/settings`);
  }

  updatePolicy(body: DeadlinePolicyView): Observable<DeadlinePolicyView> {
    return this.http.put<DeadlinePolicyView>(`${DEADLINES_API_BASE}/settings`, body);
  }

  // --- Contract decisions -----------------------------------------------------------------------------------------

  /** HR opens a decision for a fixed-term contract (`employee.contract.manage`). */
  openDecision(employmentId: string, contractId: string): Observable<ContractDecisionView> {
    return this.http.post<ContractDecisionView>(`/api/employees/${enc(employmentId)}/contracts/${enc(contractId)}/decision`, {});
  }

  /** The current step's assignee records (or changes) the proposal. */
  propose(decisionId: string, body: ProposalBody): Observable<ContractDecisionView> {
    return this.http.put<ContractDecisionView>(`${CONTRACT_DECISIONS_API_BASE}/${enc(decisionId)}/proposal`, body);
  }
}
