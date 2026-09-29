# 18. Binary files: PDFs as Blobs, object URLs and uploads

See also: [06-http-and-errors.md](./06-http-and-errors.md) (`HttpClient`, interceptors, problems),
[04-dependency-injection.md](./04-dependency-injection.md) (providers, the injector tree),
[17-multi-step-ui-wizards-and-two-step-sign-in.md](./17-multi-step-ui-wizards-and-two-step-sign-in.md) §5–6 (the
first data URL and the first Blob download), [07-forms.md](./07-forms.md) (validators, `problemToForm`).

The Documents slice (`docs/contracts/documents.md`, ADR 008) is the first time the web **receives files** from the API
(numbered PDFs: attestation de travail, certificat de travail, titre de congé) and **sends one** (the company logo).
Everything so far was JSON. This chapter covers what changes when the body is bytes.

Files: `src/app/core/documents/*`, `src/app/core/browser/blob-files.ts`, `download.ts`, `uuid.ts`,
`src/app/core/http/api-problem.interceptor.ts`, `src/app/shared/documents/*`, `src/app/features/documents/*`,
`src/app/features/my-documents/*`.

1. [Why fetch a PDF through `HttpClient` at all?](#1-why-fetch-a-pdf-through-httpclient-at-all)
2. [`responseType: 'blob'`](#2-responsetype-blob)
3. [Errors of a Blob request are Blobs too](#3-errors-of-a-blob-request-are-blobs-too)
4. [Opening and saving: object URLs, pop-up blockers, `<a download>`](#4-opening-and-saving)
5. [Cleaning up: a component-scoped service and `DestroyRef`](#5-cleaning-up-a-component-scoped-service-and-destroyref)
6. [Why a new tab and not an `<iframe>` preview (and why no `DomSanitizer`)](#6-why-a-new-tab-and-not-an-iframe)
7. [Images under a strict CSP: `data:` URLs from `FileReader`](#7-images-under-a-strict-csp)
8. [Uploading: file inputs and `FormData`](#8-uploading-file-inputs-and-formdata)
9. [An idempotent submit: `clientRequestId`](#9-an-idempotent-submit)
10. [Form values as signals, server defaults pushed by `effect()`](#10-form-values-as-signals)
11. [A discriminated union in a template (My tasks)](#11-a-discriminated-union-in-a-template)
12. [Testing binary responses](#12-testing-binary-responses)

## 1. Why fetch a PDF through `HttpClient` at all?

The simplest way to show a PDF is a link: `<a href="/api/documents/42/pdf" target="_blank">`. The browser sends the
cookies, the API answers `application/pdf`, done. We do NOT do that, because a plain navigation bypasses everything
chapter 06 and 11 built:

| | `<a href>` navigation | `HttpClient` + Blob |
|---|---|---|
| Access cookie expired (15 min) | the tab shows a raw 401 JSON | `authRefreshInterceptor` refreshes and retries |
| API refuses (`404`, `503 document-render-failed`) | a JSON page in a new tab | an `ApiProblemError` we translate on the page |
| Busy state on the button | impossible (the page does not know) | `busy` signal until the bytes arrived |
| POST with a body (the preview) | needs a hidden `<form>` + XSRF by hand | `http.post(url, body, { responseType: 'blob' })` |

So the contract says: fetch as a Blob, then hand the bytes to the browser.

## 2. `responseType: 'blob'`

`HttpClient` parses bodies as JSON by default. The `responseType` option changes that
(`core/documents/documents-api.ts`):

```ts
pdf(id: string, disposition: PdfDisposition = 'attachment'): Observable<Blob> {
  return this.http.get(`${DOCUMENTS_API_BASE}/${enc(id)}/pdf`, { params: { disposition }, responseType: 'blob' });
}
```

- The return type becomes `Observable<Blob>` by itself: `get()` has overloads keyed on the LITERAL type of
  `responseType`. Write the options object inline — `const opts = { responseType: 'blob' }` would widen `'blob'` to
  `string` and pick the wrong overload (the classic "`responseType` is not assignable" error).
- No generic: `http.get<Blob>(…)` is the JSON overload with a lie in it.
- A `Blob` is an immutable chunk of bytes with a MIME `type` (here `application/pdf`, from `Content-Type`). Nothing is
  written to disk.
- The same works for POST: `preview()` sends an `IssueBody` and receives a specimen PDF.

## 3. Errors of a Blob request are Blobs too

With `responseType: 'blob'`, HttpClient hands the **error** body over in the same type: a 409 problem+json arrives as
a `Blob`, and `parseApiProblem(blob)` would only see "an object that is not a problem". The contract calls this out:
"an error Blob must be read as JSON before mapping the slug".

The fix lives in ONE place, `core/http/api-problem.interceptor.ts`, so every Blob call benefits:

```ts
if (body instanceof Blob) {
  return from(body.text()).pipe(
    catchError(() => of(undefined)),
    switchMap((text) => throwError(() => new ApiProblemError(parseApiProblem(text, error.status, error.statusText), { cause: error }))),
  );
}
```

Reading a Blob is asynchronous (`blob.text()` is a Promise). `from(promise)` makes it an Observable and `switchMap`
turns "the text, once read" into the error. Pages then write the same code as for JSON:
`problemSlug(error.problem.type) === 'document-profile-incomplete'`.

Interceptor order matters here (chapter 06): `apiProblemInterceptor` is outside `authRefreshInterceptor`, which still
sees the raw 401 `HttpErrorResponse` and refreshes; only what finally fails is parsed.

## 4. Opening and saving

Once we hold a Blob, the browser needs a URL for it. `URL.createObjectURL(blob)` returns a `blob:` URL (same origin
as the app) that points at the bytes in memory.

**Saving** (`core/browser/download.ts`, `saveBlob()`): a temporary `<a download="ATT-2026-00042.pdf">` pointed at the
URL, clicked, removed; the URL is revoked on the next task. Chapter 17 §6 explains each step (it was built for the
recovery codes and is now shared).

**Opening in a new tab** needs one more idea. Pop-up blockers allow `window.open()` only during a user gesture. The
request takes a few hundred milliseconds; when the bytes arrive, the click is over and `window.open(url)` may be
blocked. So `BlobFiles.open()` (`core/browser/blob-files.ts`) opens an EMPTY tab synchronously — the caller must call
it from the click handler — and points it at the Blob afterwards:

```ts
open(source: Observable<Blob>, fileName: string): Observable<OpenResult> {
  return defer(() => {
    const tab = this.view.open('', '_blank');        // during the click: allowed
    return source.pipe(
      tap({ error: () => tab?.close() }),            // failed: close the empty tab
      map((blob) => {
        if (tab && !tab.closed) {
          const url = this.track(this.view.URL.createObjectURL(blob));
          tab.opener = null;                          // what rel="noopener" does for links
          tab.location.href = url;                    // about:blank is same-origin: we may navigate it
          return 'opened';
        }
        saveBlob(this.document, fileName, blob);      // blocked anyway: the user still gets the file
        return 'saved';
      }),
    );
  });
}
```

`defer()` postpones the `window.open` until someone subscribes — the component subscribes inside its click handler,
so "subscribe" and "click" are the same moment.

## 5. Cleaning up: a component-scoped service and `DestroyRef`

An object URL keeps its bytes alive until `revokeObjectURL()` or until the page unloads. In a single-page app the page
never unloads, so every PDF opened would stay in memory for the whole session. But revoking right after opening is too
early: the new tab is still loading it (and Chrome's viewer reads it again for "Save").

The answer is to tie the URLs to the life of the component that created them. `BlobFiles` is **not** `providedIn:
'root'`:

```ts
@Injectable()                                        // available nowhere by itself
export class BlobFiles {
  constructor() {
    inject(DestroyRef).onDestroy(() => { for (const url of this.urls) this.view.URL.revokeObjectURL(url); });
  }
}

@Component({ selector: 'app-pdf-actions', providers: [BlobFiles], … })   // shared/documents/pdf-actions.ts
export class PdfActions { private readonly files = inject(BlobFiles); }
```

- `providers: [BlobFiles]` on a component creates one instance per component instance, in that component's injector
  (chapter 04's injector tree). Two `<app-pdf-actions>` on the My documents page → two `BlobFiles`.
- `inject(DestroyRef)` inside that service returns the **owning component's** destroy hook (in a root service it would
  be the application's). `onDestroy` runs when the component leaves the DOM: navigation, an `@if` turning false.
- Bytes that arrive after the component was destroyed get a minute (`LATE_URL_LIFETIME_MS`) and are then revoked, so
  nothing leaks either way.

Compare with the root services of chapters 15–16 (`TasksBadge`, `NotificationCenter`): state that the whole app shares
belongs at the root; resources that belong to one piece of UI belong to that piece. The issue page provides its own
`BlobFiles` too (for "Preview").

## 6. Why a new tab and not an `<iframe>`

A preview inside the page (`<iframe [src]="pdfUrl">`) looks tempting. We chose a new tab ("Aperçu" / "Ouvrir"), for
three reasons:

1. **Angular would refuse the binding.** `[src]` on an `<iframe>` is a `RESOURCE_URL` security context: Angular never
   lets a plain string in (it throws "unsafe value used in a resource URL context"), because a frame can load and run
   anything. You would have to call `DomSanitizer.bypassSecurityTrustResourceUrl(url)` — a promise to Angular that
   you checked the URL. Bypasses are where XSS bugs hide; we keep zero of them.
2. **Phones.** iOS Safari and Android Chrome do not render PDFs inside iframes (at best a first page or a download
   button). Our screens must work at 390 px.
3. **CSP.** The production policy (`deploy/Caddyfile`) has `default-src 'none'` and no `frame-src`: an iframe would
   need a policy change for `blob:`.

In a new tab the PDF viewer of the browser (or of the phone) does what it does best, and printing — the point of these
documents, which are signed and stamped by hand — is one click. No template binding is involved: the `blob:` URL is set
in code (`tab.location.href`), so no sanitizer is involved either. `<img [src]="dataUrl">` (next section) IS a
template binding, but an `img` `src` is the weaker `URL` context, where Angular's sanitizer lets `data:image/…` through.

## 7. Images under a strict CSP

The letterhead tab (`features/documents/profile-settings.ts`) shows the current logo and a preview of a newly chosen
file. Both are bytes in the browser (`GET /documents/settings/profile/logo` as a Blob; a `File` from the file input — a
`File` IS a `Blob` with a name). An object URL would be the obvious `src`, but the production CSP allows
`img-src 'self' data:` — **not** `blob:`. So `blobToDataUrl()` (`core/browser/download.ts`) reads the bytes with
`FileReader.readAsDataURL()` into `data:image/png;base64,…`, which both the CSP and Angular's URL sanitizer accept
(chapter 17 §5). Fine for ≤ 256 KB; for large files an object URL would be the better tool (and a CSP change).

`FileReader` is callback-based; wrapping it in a Promise with `addEventListener('load' | 'error', …, { once: true })`
keeps the call sites to one `then()`.

## 8. Uploading: file inputs and `FormData`

`<input type="file">` is not bound with `formControlName`: its value is owned by the browser (a fake path), and what
matters is `input.files`. So the letterhead tab reads it in `(change)`:

```ts
protected onFile(event: Event): void {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] ?? null : null;
  // type (PNG/JPEG) and size (256 KB) checked as a COURTESY — the API sniffs the bytes and decides
}
```

and uploads it (`DocumentsApi.uploadLogo()`):

```ts
const form = new FormData();
form.append('file', file, fileName);
return this.http.put<CompanyProfileView>(`${DOCUMENTS_API_BASE}/settings/profile/logo`, form);
```

`HttpClient` sees a `FormData` body and lets the browser write `Content-Type: multipart/form-data; boundary=…`. Never
set that header yourself: without the generated boundary the server cannot split the parts. XSRF still applies (a PUT
goes through the same interceptors). The server's 422 `errors[{field: 'file', code: 'unsupported_type' | 'too_large'}]`
is translated by `logoProblem()` (`features/documents/document-forms.ts`). Phase B's employee file adds upload
progress (`reportProgress: true`, `observe: 'events'`) through a second, XHR-backed client — see
[chapter 19](./19-uploads-progress-and-the-employee-file.md).

## 9. An idempotent submit

Issuing consumes a number from a gap-free sequence (ADR 008). If the network drops AFTER the server committed, a naive
retry would issue a second document. The contract's answer is a `clientRequestId` (a UUID) per form fill:

- `IssuePage.issue()` creates it on the first submit (`this.clientRequestId ??= newUuid()`) and reuses it for retries;
  the API answers a replay with **200 and the same document**.
- Any change to the form starts a new fill: `form.valueChanges` resets the id to `null`.
- The button is disabled while the POST is pending (a double click never sends twice).

`newUuid()` (`core/browser/uuid.ts`) uses `crypto.randomUUID()` when the page is a secure context and falls back to
`getRandomValues()` otherwise.

## 10. Form values as signals

The issue page must re-ask the server when the user picks another employee (the signatories covering them, their
approved leave requests). Resources are keyed on signals; form controls emit Observables. `toSignal()` bridges them:

```ts
private readonly employmentId = toSignal(this.form.controls.employmentId.valueChanges, { initialValue: null });
protected readonly signatories = this.api.signatoriesForResource(this.employmentId);
```

The other direction — server data INTO the form (preselect the type's default signatory when the list arrives) — is a
side effect, so an `effect()`; `untracked()` keeps the effect from depending on the control it writes. A control that
exists for one type only (`leaveRequestId`, for a titre de congé) is enabled/disabled by an effect: a disabled control
does not count for validity.

## 11. A discriminated union in a template

My tasks now lists two kinds of subject (`core/tasks/tasks.models.ts`): `LeaveTaskSubject | DocumentTaskSubject`, told
apart by `type`. In `features/tasks/tasks.page.html`:

```html
@if (task.subject.type === 'leave_request') {
  {{ catalog.nameOf(task.subject.leaveTypeId) }} …
} @else {
  {{ catalog.labelOf(task.subject.documentType.labels) }} …
}
```

With `strictTemplates`, Angular type-checks templates by generating TypeScript, and an `@if` becomes an `if`: the union
**narrows** inside the block exactly as in code. `task.subject.leaveTypeId` compiles in the first branch and would be
an error in the `@else`. Same rule in the class (`selectedRequestId` only keys the leave detail resource on leave
subjects).

## 12. Testing binary responses

- `HttpTestingController` flushes Blobs: `req.flush(new Blob(['%PDF'], { type: 'application/pdf' }))`; assert
  `req.request.responseType === 'blob'`.
- An error body as a Blob, to exercise §3: `req.flush(problemBlob('document-profile-incomplete'), { status: 409,
  statusText: 'Conflict' })` (`src/testing/document-fixtures.ts`). Reading the Blob is async: `settle()` twice.
- `window.open` and `URL.createObjectURL` are browser APIs, so spy on them: `vi.spyOn(window, 'open')` returning a fake
  `{ location: { href: '' }, close }` shows that the tab was opened BEFORE the bytes arrived and pointed at the URL
  after (`core/browser/blob-files.spec.ts`); returning `null` exercises the "blocked → saved" path.
- Destroying the host (`fixture.destroy()`) triggers `DestroyRef` → the URL is revoked: the component-scoped
  lifetime is testable with a three-line host component.
- `FormData` bodies: `expect(req.request.body).toBeInstanceOf(FormData)` and no `Content-Type` header.
