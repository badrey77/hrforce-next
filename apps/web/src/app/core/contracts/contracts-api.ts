/**
 * ContractsApi — the employment-contract endpoints (`docs/contracts/contracts-deadlines.md` › Contracts): the list is a
 * resource keyed on the employment, writes are one-shot Observables.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { employeeUrl } from '../employees/employees-api';
import type { ContractCorrection, ContractList, ContractView, NewContract } from './contracts.models';

export function contractsUrl(employmentId: string, suffix = ''): string {
  return employeeUrl(employmentId, `/contracts${suffix}`);
}

@Injectable({ providedIn: 'root' })
export class ContractsApi {
  private readonly http = inject(HttpClient);

  /** `GET /employees/:id/contracts`; `undefined` from `employmentId` = no request. */
  listResource(employmentId: () => string | null | undefined): HttpResourceRef<ContractList | undefined> {
    return httpResource<ContractList>(() => {
      const id = employmentId();
      return id ? contractsUrl(id) : undefined;
    });
  }

  /** `POST /employees/:id/contracts` → 201. */
  create(employmentId: string, body: NewContract): Observable<ContractView> {
    return this.http.post<ContractView>(contractsUrl(employmentId), body);
  }

  /** `PATCH /employees/:id/contracts/:contractId` (the latest contract only). */
  correct(employmentId: string, contractId: string, body: ContractCorrection): Observable<ContractView> {
    return this.http.patch<ContractView>(contractsUrl(employmentId, `/${encodeURIComponent(contractId)}`), body);
  }

  /** `POST /employees/:id/contracts/:contractId/decision` → 201: HR opens a contract decision (unit head → HR). */
  openDecision(employmentId: string, contractId: string): Observable<{ readonly id: string }> {
    return this.http.post<{ readonly id: string }>(contractsUrl(employmentId, `/${encodeURIComponent(contractId)}/decision`), {});
  }
}
