/**
 * KioskApi — the three calls of the entrance display (docs/contracts/attendance.md › Device side, ADR 009 §1–2).
 * The tablet is a paired DEVICE, not a user: its credential is the `httpOnly` cookie `hrf_kiosk`
 * (`Path=/api/kiosk`), which the browser attaches by itself. No user session is involved, so:
 * - the refresh interceptor never touches `/api/kiosk/*` (core/auth/auth-refresh.interceptor.ts › `isRefreshable`):
 *   a 401 here means "this tablet is not (or no longer) paired", never "the access token expired";
 * - errors still go through the problem interceptor, so the page reads `ApiProblemError.status`.
 *
 * Angular concepts: a root service with plain Observables. It is only imported by the lazily loaded kiosk page
 * (features/kiosk/), so the bundler puts it in the kiosk's chunk: `providedIn: 'root'` says WHO owns the instance
 * (the root injector, created on first `inject()`), not WHERE the code is bundled.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { KioskQrView, KioskSessionView } from './attendance.models';

export const KIOSK_API_BASE = '/api/kiosk';

@Injectable({ providedIn: 'root' })
export class KioskApi {
  private readonly http = inject(HttpClient);

  /** `GET /kiosk/session` → 200 (the cookie is renewed for 400 days); 401 `kiosk-unpaired`; 403 `kiosk-network-refused`. */
  session(): Observable<KioskSessionView> {
    return this.http.get<KioskSessionView>(`${KIOSK_API_BASE}/session`);
  }

  /** `POST /kiosk/pair {code}` → 200 + the device cookie; 410 `kiosk-pairing-invalid`; 422 `code` malformed. */
  pair(code: string): Observable<KioskSessionView> {
    return this.http.post<KioskSessionView>(`${KIOSK_API_BASE}/pair`, { code });
  }

  /** `GET /kiosk/qr` → the current window and the next three (`Cache-Control: no-store`). */
  qr(): Observable<KioskQrView> {
    return this.http.get<KioskQrView>(`${KIOSK_API_BASE}/qr`);
  }
}
