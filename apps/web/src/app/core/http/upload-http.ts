/**
 * `UPLOAD_HTTP_CLIENT` — a second `HttpClient`, identical to the app's except for its transport: `XMLHttpRequest`
 * instead of `fetch()`, because only XHR reports how many bytes of a request BODY have been sent. Used for uploads that
 * show a progress bar (the employee file, core/employee-files/employee-files-api.ts).
 *
 *   private readonly uploads = inject(UPLOAD_HTTP_CLIENT);
 *   this.uploads.post(url, formData, { reportProgress: true, observe: 'events' })   // → HttpEvent stream
 *
 * Why not simply switch the whole app to XHR? The app is configured with `withFetch()` (app.config.ts) and Angular's
 * fetch backend REFUSES upload progress: the Fetch API has no upload-progress event, so Angular throws "The FetchBackend
 * does not support upload progress reporting" for `reportUploadProgress`, and `reportProgress` only yields DOWNLOAD
 * progress there. Everything else in the app is fine on fetch, so only uploads take the other road.
 *
 * Angular concepts:
 * - **An `InjectionToken` with a `factory`** (chapter 04, core/notifications/event-source.ts): `providedIn: 'root'`
 *   makes it available everywhere, built on first `inject()`. Tests replace it with the testing client
 *   (`{ provide: UPLOAD_HTTP_CLIENT, useExisting: HttpClient }`), so `HttpTestingController` sees uploads too.
 * - **A child `EnvironmentInjector`** (`createEnvironmentInjector(providers, parent)`). Environment injectors are the
 *   non-component injectors: the root one (app.config.ts) and one per lazy route with `providers`. Making one by hand
 *   gives a small scope where `provideHttpClient(withXhr(), …)` builds its OWN `HttpClient`, `HttpBackend` and
 *   interceptor chain, while every token it does not provide — `Session`, `Router`, `TokenRefresher`, `XhrFactory` —
 *   is looked up in the parent (the root), so the interceptors share the app's single session and refresh flight.
 * - **Same features, other transport**: `appHttpFeatures()` (http-features.ts) gives XSRF + the same interceptors in
 *   the same order. A retried upload after a 401 re-sends the same `FormData` (it can be read twice, unlike a stream).
 * - The child injector lives as long as the app (the token is a root singleton), so it is never destroyed.
 */
import { HttpClient, provideHttpClient, withXhr } from '@angular/common/http';
import { createEnvironmentInjector, EnvironmentInjector, InjectionToken, inject } from '@angular/core';
import { appHttpFeatures } from './http-features';

export const UPLOAD_HTTP_CLIENT = new InjectionToken<HttpClient>('UPLOAD_HTTP_CLIENT', {
  providedIn: 'root',
  factory: () =>
    createEnvironmentInjector(
      [provideHttpClient(withXhr(), ...appHttpFeatures())],
      inject(EnvironmentInjector),
      'UploadHttpClient',
    ).get(HttpClient),
});
