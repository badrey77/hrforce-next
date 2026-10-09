/** HTTP calls of the branding contract (docs/contracts/branding.md › Endpoints). */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  BrandingSettingsView,
  CompanyBrandingBody,
  CompanyLogoKind,
  InstallationBrandingBody,
  PublicBranding,
} from './branding.models';

export const BRANDING_API_BASE = '/api/branding';

/** Which stored logo a call is about: the installation's app logo, or one of the company's two. */
export type LogoTarget = 'installation' | CompanyLogoKind;

function logoUrl(target: LogoTarget): string {
  return target === 'installation' ? `${BRANDING_API_BASE}/installation/logo` : `${BRANDING_API_BASE}/company/logos/${target}`;
}

@Injectable({ providedIn: 'root' })
export class BrandingApi {
  private readonly http = inject(HttpClient);

  /** Public: what the sign-in page shows. */
  publicDefault(): Observable<PublicBranding> {
    return this.http.get<PublicBranding>(`${BRANDING_API_BASE}/default`);
  }

  settingsResource(): HttpResourceRef<BrandingSettingsView | undefined> {
    return httpResource<BrandingSettingsView>(() => `${BRANDING_API_BASE}/settings`);
  }

  saveCompany(body: CompanyBrandingBody): Observable<BrandingSettingsView> {
    return this.http.put<BrandingSettingsView>(`${BRANDING_API_BASE}/company`, body);
  }

  saveInstallation(body: InstallationBrandingBody): Observable<BrandingSettingsView> {
    return this.http.put<BrandingSettingsView>(`${BRANDING_API_BASE}/installation`, body);
  }

  /** Reset: every text, the colour and the logos of that level. 204. */
  reset(level: 'installation' | 'company'): Observable<void> {
    return this.http.delete<void>(`${BRANDING_API_BASE}/${level}`);
  }

  uploadLogo(target: LogoTarget, file: Blob, fileName = 'logo'): Observable<BrandingSettingsView> {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.http.put<BrandingSettingsView>(logoUrl(target), form);
  }

  deleteLogo(target: LogoTarget): Observable<void> {
    return this.http.delete<void>(logoUrl(target));
  }

  /** The bytes behind a logo URL given by the API (same origin, under `/api/branding/`). */
  logoBytes(url: string): Observable<Blob> {
    return this.http.get(url, { responseType: 'blob' });
  }
}
