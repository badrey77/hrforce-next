/**
 * `BlobFiles` — open bytes the API sent (a PDF) in a new tab, or save them as a file. PROVIDED BY A COMPONENT
 * (`providers: [BlobFiles]`), never at the root:
 *
 *   @Component({ providers: [BlobFiles], … })
 *   export class PdfActions { private readonly files = inject(BlobFiles); … this.files.open(api.pdf(id, 'inline'), name) }
 *
 * Angular concepts:
 * - **A component-scoped service.** `@Injectable()` without `providedIn` is not available anywhere by itself. Listing
 *   it in a component's `providers` makes that component's injector create ONE instance per component instance, and
 *   destroy it with the component. Two "Open" buttons on the page → two `BlobFiles`, each with its own URLs.
 * - **`DestroyRef` for cleanup.** `inject(DestroyRef)` inside such a service returns the OWNING COMPONENT's destroy
 *   hook (for a root service it would be the application's). `onDestroy()` registers a callback that runs when the
 *   component is removed (navigation, `@if` turning false). That is where the object URLs are revoked: a
 *   `URL.createObjectURL()` keeps the bytes alive in the browser until `revokeObjectURL()` or the page unloads — in a
 *   single-page app the page never unloads, so without this every PDF opened would stay in memory for the session.
 *   Why not revoke right after opening? The new tab is still loading the URL (and Chrome's viewer reads it again for
 *   "Save" and on reload); revoking at once can leave it blank. Saving a file (`saveBlob`) revokes on the next task
 *   because the download has started by then.
 * - **Opening a tab after an async request.** Pop-up blockers allow `window.open()` only during a user gesture (a
 *   click). By the time the PDF has arrived, the click is over. So `open()` opens an empty tab SYNCHRONOUSLY — callers
 *   must call it from the click handler — and points it at the `blob:` URL when the bytes arrive (the empty tab is
 *   `about:blank`, same origin as the app, so we may set its location). If that tab was blocked anyway, the bytes are
 *   SAVED instead (the result says which), so the user always gets the file.
 * - **No sanitizer involved**: nothing here is bound in a template; `location.href` and the temporary anchor are set in
 *   code, and the URL is a `blob:` URL of bytes from our own API (see download.ts).
 *
 * Returns cold Observables: nothing happens until the caller subscribes (the component tracks busy/error state).
 */
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { defer, map, type Observable, tap } from 'rxjs';
import { saveBlob } from './download';

export type OpenResult = 'opened' | 'saved';

/** How long an object URL created after its owner was destroyed stays valid (the tab is still loading it). */
export const LATE_URL_LIFETIME_MS = 60_000;

@Injectable()
export class BlobFiles {
  private readonly document = inject(DOCUMENT);
  /** Object URLs of opened tabs, revoked when the owning component is destroyed. */
  private readonly urls = new Set<string>();
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const url of this.urls) this.view.URL.revokeObjectURL(url);
      this.urls.clear();
    });
  }

  /** Keeps `url` until the owner is destroyed; bytes arriving after that get a minute to load, then go. */
  private track(url: string): string {
    if (this.destroyed) this.view.setTimeout(() => this.view.URL.revokeObjectURL(url), LATE_URL_LIFETIME_MS);
    else this.urls.add(url);
    return url;
  }

  private get view(): Window & typeof globalThis {
    return this.document.defaultView ?? window;
  }

  /**
   * Opens the bytes of `source` in a new tab. CALL FROM A CLICK HANDLER (see header). `mime` types an untyped blob so
   * the browser picks its PDF viewer.
   */
  open(source: Observable<Blob>, fileName: string, mime = 'application/pdf'): Observable<OpenResult> {
    return defer(() => {
      const tab = this.view.open('', '_blank');
      return source.pipe(
        tap({ error: () => tab?.close() }),
        map((blob) => {
          const typed = blob.type ? blob : new Blob([blob], { type: mime });
          if (tab && !tab.closed) {
            const url = this.track(this.view.URL.createObjectURL(typed));
            tab.opener = null; // the new tab gets no handle back to the app (what `rel="noopener"` does for links)
            tab.location.href = url;
            return 'opened';
          }
          saveBlob(this.document, fileName, typed);
          return 'saved';
        }),
      );
    });
  }

  /** Saves the bytes of `source` as `fileName` (a temporary `<a download>`). */
  save(source: Observable<Blob>, fileName: string): Observable<void> {
    return source.pipe(map((blob) => saveBlob(this.document, fileName, blob)));
  }
}
