/**
 * PayrollApi — every endpoint of docs/contracts/payroll-variables.md › Endpoints. Reads are `httpResource`s (create
 * them from a field initializer) plus one-shot `get…` Observables; writes are Observables. Files (export, control
 * report) arrive as a `Blob` with the name the API put in `Content-Disposition`.
 */
import { HttpClient, type HttpResourceRef, type HttpResponse, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  type DownloadedFile,
  type EmployeeCodeView,
  type EmployeeVariables,
  type ExportFilter,
  exportFilterParams,
  filenameFromDisposition,
  type LineInput,
  type NewRubrique,
  type PayrollSettings,
  type PeriodList,
  type PeriodView,
  type RubriqueList,
  type RubriqueUpdate,
  type RubriqueView,
  type SettingsPreview,
  type VariablesPage,
  type VariablesQuery,
  variablesParams,
} from './payroll.models';

export const PAYROLL_API_BASE = '/api/payroll';

const enc = encodeURIComponent;

function periodUrl(month: string): string {
  return `${PAYROLL_API_BASE}/periods/${enc(month)}`;
}

function toFile(response: HttpResponse<Blob>, fallback: string): DownloadedFile {
  return {
    blob: response.body ?? new Blob([]),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'), fallback),
  };
}

@Injectable({ providedIn: 'root' })
export class PayrollApi {
  private readonly http = inject(HttpClient);

  // --- Periods ------------------------------------------------------------------------------------------------------

  /** `GET /payroll/periods?year=` (`year` null → this year). `undefined` → no request. */
  periodsResource(year: () => number | null | undefined): HttpResourceRef<PeriodList | undefined> {
    return httpResource<PeriodList>(() => {
      const value = year();
      if (value === undefined) return undefined;
      const params: Record<string, string> = value === null ? {} : { year: String(value) };
      return { url: `${PAYROLL_API_BASE}/periods`, params };
    });
  }

  /** `GET /payroll/periods/:month`. `month` undefined/null → no request. */
  periodResource(month: () => string | null | undefined): HttpResourceRef<PeriodView | undefined> {
    return httpResource<PeriodView>(() => {
      const value = month();
      return value ? periodUrl(value) : undefined;
    });
  }

  getPeriod(month: string): Observable<PeriodView> {
    return this.http.get<PeriodView>(periodUrl(month));
  }

  /** `GET /payroll/periods/:month/variables`. */
  variablesResource(
    month: () => string | null | undefined,
    query: () => VariablesQuery | undefined,
    lang: () => string | null = () => null,
  ): HttpResourceRef<VariablesPage | undefined> {
    return httpResource<VariablesPage>(() => {
      const m = month();
      const q = query();
      return m && q ? { url: `${periodUrl(m)}/variables`, params: variablesParams(q, lang()) } : undefined;
    });
  }

  /** `GET /payroll/periods/:month/variables/:employeeId`. */
  employeeVariablesResource(month: () => string | null | undefined, employeeId: () => string | null | undefined): HttpResourceRef<EmployeeVariables | undefined> {
    return httpResource<EmployeeVariables>(() => {
      const m = month();
      const id = employeeId();
      return m && id ? `${periodUrl(m)}/variables/${enc(id)}` : undefined;
    });
  }

  getEmployeeVariables(month: string, employeeId: string): Observable<EmployeeVariables> {
    return this.http.get<EmployeeVariables>(`${periodUrl(month)}/variables/${enc(employeeId)}`);
  }

  /** Sets (or changes) HR's value of one line. */
  putLine(month: string, employeeId: string, body: LineInput): Observable<EmployeeVariables> {
    return this.http.put<EmployeeVariables>(`${periodUrl(month)}/variables/${enc(employeeId)}/lines`, body);
  }

  /** Removes HR's value (back to the computed value, or no line for a manual rubrique). */
  deleteLine(month: string, employeeId: string, rubriqueId: string, originMonth?: string | null): Observable<EmployeeVariables> {
    const options = originMonth ? { params: { originMonth } } : {};
    return this.http.delete<EmployeeVariables>(`${periodUrl(month)}/variables/${enc(employeeId)}/lines/${enc(rubriqueId)}`, options);
  }

  /** `PUT /payroll/employee-codes/:employeeId` (`code` null → back to the matricule). */
  setEmployeeCode(employeeId: string, code: string | null): Observable<EmployeeCodeView> {
    return this.http.put<EmployeeCodeView>(`${PAYROLL_API_BASE}/employee-codes/${enc(employeeId)}`, { code });
  }

  close(month: string): Observable<PeriodView> {
    return this.http.post<PeriodView>(`${periodUrl(month)}/close`, {});
  }

  reopen(month: string, reason: string): Observable<PeriodView> {
    return this.http.post<PeriodView>(`${periodUrl(month)}/reopen`, { reason });
  }

  // --- Files --------------------------------------------------------------------------------------------------------

  /** The payroll file; `draft` for an open month (live values). */
  exportFile(month: string, filter: ExportFilter | null = null, draft = false): Observable<DownloadedFile> {
    const params: Record<string, string> = { ...exportFilterParams(filter) };
    if (draft) params['draft'] = 'true';
    const fallback = `variables-paie-${month}${draft ? '-brouillon' : ''}.csv`;
    return this.http
      .get(`${periodUrl(month)}/export`, { params, responseType: 'blob', observe: 'response' })
      .pipe(map((response) => toFile(response, fallback)));
  }

  /** The control report (UTF-8 CSV), header in `lang`. */
  controlReport(month: string, lang: 'fr' | 'ar', filter: ExportFilter | null = null): Observable<DownloadedFile> {
    const params: Record<string, string> = { ...exportFilterParams(filter), lang };
    return this.http
      .get(`${periodUrl(month)}/control.csv`, { params, responseType: 'blob', observe: 'response' })
      .pipe(map((response) => toFile(response, `etat-controle-paie-${month}.csv`)));
  }

  // --- Settings and rubriques ---------------------------------------------------------------------------------------

  settingsResource(enabled: () => boolean = () => true): HttpResourceRef<PayrollSettings | undefined> {
    return httpResource<PayrollSettings>(() => (enabled() ? `${PAYROLL_API_BASE}/settings` : undefined));
  }

  updateSettings(body: PayrollSettings): Observable<PayrollSettings> {
    return this.http.put<PayrollSettings>(`${PAYROLL_API_BASE}/settings`, body);
  }

  getPreview(): Observable<SettingsPreview> {
    return this.http.get<SettingsPreview>(`${PAYROLL_API_BASE}/settings/preview`);
  }

  rubriquesResource(enabled: () => boolean = () => true): HttpResourceRef<RubriqueList | undefined> {
    return httpResource<RubriqueList>(() => (enabled() ? `${PAYROLL_API_BASE}/rubriques` : undefined));
  }

  getRubriques(): Observable<RubriqueList> {
    return this.http.get<RubriqueList>(`${PAYROLL_API_BASE}/rubriques`);
  }

  createRubrique(body: NewRubrique): Observable<RubriqueView> {
    return this.http.post<RubriqueView>(`${PAYROLL_API_BASE}/rubriques`, body);
  }

  updateRubrique(id: string, body: RubriqueUpdate): Observable<RubriqueView> {
    return this.http.put<RubriqueView>(`${PAYROLL_API_BASE}/rubriques/${enc(id)}`, body);
  }
}
