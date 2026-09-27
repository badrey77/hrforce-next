/**
 * MfaApi — the signed-in user's own two-step sign-in endpoints, `/api/me/mfa*` (docs/contracts/mfa.md › Endpoints).
 * The login-time `POST /auth/mfa/verify` lives in `AuthApi` with the other `/auth` calls.
 *
 * Same split as the other `*Api` services (core/org/org-api.ts explains it): the status a page SHOWS is an
 * `httpResource` (re-read with `reload()` after each change), the actions are cold Observables sent on subscribe.
 * Every endpoint here is `@AllowWithoutMfa` on the server: it keeps working while enrollment is required, which is
 * what lets the enforcement guard send people to /me/security instead of locking them out.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { MfaEnrollment, MfaStatus, RecoveryCodes } from './mfa.models';

export const MFA_API_BASE = '/api/me/mfa';

@Injectable({ providedIn: 'root' })
export class MfaApi {
  private readonly http = inject(HttpClient);

  /** `GET /me/mfa` — fetched when the resource is created (the security page), again on `reload()`. */
  statusResource(): HttpResourceRef<MfaStatus | undefined> {
    return httpResource<MfaStatus>(() => MFA_API_BASE);
  }

  /** `POST /me/mfa/enroll/start` → secret, otpauth URI and QR (PNG data URL). */
  startEnrollment(): Observable<MfaEnrollment> {
    return this.http.post<MfaEnrollment>(`${MFA_API_BASE}/enroll/start`, null);
  }

  /** `POST /me/mfa/enroll/confirm` `{code}` → the recovery codes, once. 422 `mfa-invalid`; 409 `mfa-already-enabled`. */
  confirmEnrollment(code: string): Observable<RecoveryCodes> {
    return this.http.post<RecoveryCodes>(`${MFA_API_BASE}/enroll/confirm`, { code });
  }

  /** `POST /me/mfa/recovery-codes` `{code}` → a new set; the old set stops working. */
  regenerateRecoveryCodes(code: string): Observable<RecoveryCodes> {
    return this.http.post<RecoveryCodes>(`${MFA_API_BASE}/recovery-codes`, { code });
  }

  /** `POST /me/mfa/disable` `{code}` → 204. 409 `mfa-required-by-policy`. */
  disable(code: string): Observable<void> {
    return this.http.post<void>(`${MFA_API_BASE}/disable`, { code });
  }
}
