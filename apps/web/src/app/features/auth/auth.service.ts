import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

/**
 * Stub until the Identity module lands: the API sets httpOnly session cookies,
 * so the body is not used by the client yet.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  login(credentials: LoginRequest): Observable<void> {
    return this.http.post<void>('/api/auth/login', credentials);
  }
}
