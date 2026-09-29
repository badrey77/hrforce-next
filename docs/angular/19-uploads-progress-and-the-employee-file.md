# 19. Uploads with progress, drag and drop, and the employee file

See also: [18-binary-files-blobs-and-uploads.md](./18-binary-files-blobs-and-uploads.md) (Blobs, `BlobFiles`, the first
`FormData` upload), [06-http-and-errors.md](./06-http-and-errors.md) (`provideHttpClient`, interceptors),
[04-dependency-injection.md](./04-dependency-injection.md) (injectors, `InjectionToken`),
[07-forms.md](./07-forms.md) (validators, `problemToForm`), [12-permission-aware-ui.md](./12-permission-aware-ui.md)
(`_actions`, `_redacted`).

Phase B of the Documents slice (`docs/contracts/documents.md` › Phase B) adds the **employee file**: HR uploads
diplomas, contracts, ID documents… to an employee, grouped by category; files can be downloaded and deleted (with a
reason). Files are up to 10 MB, so — unlike the 256 KB logo of chapter 18 — the user needs to see the upload progress.

Files: `src/app/core/employee-files/*`, `src/app/core/http/upload-http.ts`, `http-features.ts`,
`src/app/features/employees/employee-file-tab.ts` / `.html`, `employee-file-upload.ts` / `.html`,
`employee-file-forms.ts`, `src/app/features/documents/file-categories-settings.ts`,
`src/app/shared/file-size/file-size.pipe.ts`.

1. [Upload progress: `reportProgress` and `observe: 'events'`](#1-upload-progress)
2. [Why a second `HttpClient` (fetch has no upload progress)](#2-why-a-second-httpclient)
3. [Building it: a child `EnvironmentInjector`](#3-building-it-a-child-environmentinjector)
4. [Cancelling an upload = unsubscribing](#4-cancelling-an-upload)
5. [A form control no input is bound to (the file)](#5-a-form-control-no-input-is-bound-to)
6. [Drag and drop](#6-drag-and-drop)
7. [Client-side checks are a courtesy; the server decides](#7-client-side-checks-are-a-courtesy)
8. [`<progress>`, `[attr.value]` and the indeterminate state](#8-progress-and-attrvalue)
9. [The Dossier tab: `_actions`, `_redacted`, `<details>` groups](#9-the-dossier-tab)
10. [Confirm before delete](#10-confirm-before-delete)
11. [Formatting sizes: a pure pipe over `Intl.NumberFormat`](#11-formatting-sizes)
12. [Testing uploads](#12-testing-uploads)

## 1. Upload progress

By default an `HttpClient` call emits **one** value: the parsed body. Two options change that
(`core/employee-files/employee-files-api.ts`):

```ts
this.uploads.post<EmployeeFileView>(url, formData, { reportProgress: true, observe: 'events' })
```

- `observe: 'events'` → the Observable emits every `HttpEvent` of the exchange: `Sent`, then `UploadProgress`
  (`loaded`, `total` bytes of the body, many times), `ResponseHeader`, `DownloadProgress`, and last `Response` (an
  `HttpResponse` with `body`). The return type becomes `Observable<HttpEvent<EmployeeFileView>>`.
- `reportProgress: true` → the backend actually produces progress events (each one triggers change detection, so it is
  opt-in).

`HttpEventType` tells the events apart, and TypeScript narrows the union on it:

```ts
export function toUploadEvent(event: HttpEvent<EmployeeFileView>, size: number): UploadEvent | null {
  switch (event.type) {
    case HttpEventType.Sent:           return { kind: 'progress', loaded: 0, total: size };
    case HttpEventType.UploadProgress: return { kind: 'progress', loaded: event.loaded, total: event.total ?? null };
    case HttpEventType.Response:       return event.body ? { kind: 'done', file: event.body } : null;
    default:                           return null;
  }
}
```

`upload()` maps to this small union and `filter`s out the `null`s, so the component deals with "progress" and "done"
and never with HTTP details. `total` can be missing (the browser does not always know the body length): the UI then
shows an indeterminate bar (§8).

## 2. Why a second `HttpClient`

`app.config.ts` configures `provideHttpClient(withFetch(), …)`: requests go through the browser's `fetch()`. The Fetch
API has **no upload-progress event** (only the response body can be read as a stream). Angular is explicit about it:
with the fetch backend, `reportUploadProgress` throws "The FetchBackend does not support upload progress reporting.
Please use `withXhr()`…", and `reportProgress` only yields DOWNLOAD progress. `XMLHttpRequest` has `xhr.upload.onprogress`.

Two options:

| | Whole app on `withXhr()` | A second, XHR-backed client for uploads |
|---|---|---|
| Change | one line in app.config.ts | a token + a child injector (`core/http/upload-http.ts`) |
| Everything else | leaves fetch (chapter 06's choice) | unchanged |
| Risk | every request of the app changes transport | only uploads do |

We chose the second: uploads are one screen; the rest of the app keeps what chapters 06 and 11 describe.

## 3. Building it: a child `EnvironmentInjector`

```ts
// core/http/upload-http.ts
export const UPLOAD_HTTP_CLIENT = new InjectionToken<HttpClient>('UPLOAD_HTTP_CLIENT', {
  providedIn: 'root',
  factory: () =>
    createEnvironmentInjector(
      [provideHttpClient(withXhr(), ...appHttpFeatures())],
      inject(EnvironmentInjector),
      'UploadHttpClient',
    ).get(HttpClient),
});
```

- **Environment injectors** are the non-component injectors (chapter 04): the root one built from `app.config.ts`, and
  one per lazy route that declares `providers`. `createEnvironmentInjector(providers, parent)` makes one by hand.
- Inside it, `provideHttpClient(withXhr(), …)` builds a complete, separate `HttpClient` with its own `HttpBackend`
  (XHR) and interceptor chain. Anything the child does not provide — `Session`, `Router`, `TokenRefresher`, the
  browser's `XhrFactory` — is looked up in the **parent**, so the interceptors of both clients share one session and
  one refresh-in-flight (chapter 11).
- `appHttpFeatures()` (`core/http/http-features.ts`) is the single list of shared features: XSRF names + the
  interceptors in their order. `app.config.ts` uses it too, so the two clients cannot drift apart:

```ts
provideHttpClient(withFetch(), ...appHttpFeatures())      // app.config.ts
provideHttpClient(withXhr(),   ...appHttpFeatures())      // upload-http.ts
```

- The token is an **`InjectionToken` with a `factory`** (`providedIn: 'root'`): created on the first `inject()`, a
  singleton afterwards, and replaceable in tests (§12). `EmployeeFilesApi` uses `inject(HttpClient)` for everything
  and `inject(UPLOAD_HTTP_CLIENT)` for `upload()` only.
- A 401 during an upload is refreshed and retried like any request: `FormData` can be sent twice (it is not a stream).

## 4. Cancelling an upload

An HttpClient Observable aborts its request when the subscriber unsubscribes (the XHR backend calls `xhr.abort()` in
its teardown). So the "Stop sending" button is:

```ts
this.subscription?.unsubscribe();
```

and `takeUntilDestroyed(this.destroyRef)` does the same when the form is destroyed mid-upload (the tab closes, the
user navigates). Compare with chapter 18 §5, where the PDF request deliberately keeps running after navigation: there a
new tab is already waiting for the bytes; here nobody would see the result of an upload whose form is gone.

## 5. A form control no input is bound to

In `employee-file-upload.ts` the chosen file lives in the form like any field:

```ts
file: this.fb.control<File | null>(null, [Validators.required, acceptedFile]),
```

but **no element** has `formControlName="file"`. A `<input type="file">` has no useful value accessor (the browser owns
its value, `C:\fakepath\…`; only `input.files` matters — chapter 18 §8), and a dropped file never goes through the
input at all. So both `(change)` and `(drop)` call `choose(file)`, which `setValue()`s the control. Keeping the file in
the group still pays:

- `Validators.required` and the `acceptedFile` validator run with the other fields; `form.invalid` covers everything;
- the server's 422 `errors[{field: 'file', code}]` and the 409 `employee-file-duplicate` land on it like on any field
  (`uploadProblemToForm()`, `employee-file-forms.ts`), with a translated message;
- a server error stays on the control until another file is chosen: re-sending the same refused bytes is blocked.

**A proposed value that yields to the user.** Choosing a file proposes a title from its name
(`titleFromFileName('diplome_master-2014.pdf')` → `diplome master 2014`) only while the title control is pristine.
Angular marks a control `dirty` on user input and never on `setValue()`, so `!title.dirty` means "the user has not
typed a title" — choosing another file then updates the proposal, but never overwrites what the user wrote.

**A rule between two fields.** The expiry date may not precede the document date. The rule sits on `expiresOn`
(`notBefore(…)`, the validator of `employee-forms.ts`) and READS the other control when it runs. It is added in the
constructor with `addValidators()` — in the `fb.group({…})` literal, a validator reading `this.form` would reference the
form in its own initializer, which TypeScript refuses (TS7022). Angular re-runs a control's validators only when **that**
control changes, so the component also re-checks `expiresOn` whenever `documentDate` changes:

```ts
constructor() {
  const { documentDate, expiresOn } = this.form.controls;
  expiresOn.addValidators(notBefore(() => documentDate.value || null));
  documentDate.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => expiresOn.updateValueAndValidity());
}
```

`takeUntilDestroyed()` needs no argument in a constructor (an injection context): it finds the component's
`DestroyRef` itself. Checking in the page gives a translated message under the field; the API's 422
`before_document_date` is the backstop (its message is English). A group-level validator (`birthBeforeHire` in
`employee-create.page.ts`) is the other way; a control-level one puts the error under the field that must change.

## 6. Drag and drop

```html
<div class="field drop-zone" [class.over]="dragOver()"
     (dragenter)="onDragOver($event)" (dragover)="onDragOver($event)"
     (dragleave)="dragOver.set(false)" (drop)="onDrop($event)">
  <label for="file-input">Fichier</label>
  <input id="file-input" type="file" [accept]="accept" (change)="onFileInput($event)" />
</div>
```

- Two `preventDefault()`s are mandatory. On `dragover`, the browser's default is "no drop here": without
  `preventDefault()` the `drop` event never fires. On `drop`, the default is to **open the file** in the tab, replacing
  the app.
- `event.dataTransfer.files` is a `FileList`, like `input.files`. Several files dropped → the first is kept and a hint
  says so (the API takes exactly one).
- The visible file input stays the accessible way in (keyboard, screen readers, phones — which have no drag and drop).
  Drag and drop is a shortcut, never the only path.
- No directive is needed: event bindings on DOM events are enough. A reusable `appDropZone` directive would pay off
  with a second drop zone.

## 7. Client-side checks are a courtesy

`checkFile()` (`core/employee-files/employee-files.models.ts`) refuses empty files, types other than PDF/JPEG/PNG and
files over 10 MB **before** sending, to spare the user a long upload that the server would refuse. It is not a security
control, and the API does not trust it:

- `File.type` is the browser's guess **from the file name**: rename `setup.exe` to `cv.pdf` and it says
  `application/pdf`. The API reads the first bytes (`%PDF-`, `FF D8 FF`, the PNG signature) and ignores both the name
  and the declared `Content-Type`.
- Anyone can send a request without the page. Only the server sees every request.
- The limit on the server is configurable (`EMPLOYEE_FILE_MAX_BYTES`, up to 20 MB); the web checks the contract's
  default. The server's own answers (422 `too_large`, `unsupported_type`, `empty`) are translated the same way.
- A **413** does not come from the API but from the reverse proxy in front of it (`deploy/Caddyfile` refuses upload
  bodies over 25 MB before they reach the API). Its body is not a problem document, but the error interceptor still
  turns it into an `ApiProblemError` with `status: 413`; `uploadProblemToForm()` shows it as "file too large" on the
  file field. Without that line the user would read "an unexpected error occurred".

The `accept="application/pdf,image/jpeg,image/png"` attribute only filters the file picker (users can still choose "all
files").

## 8. `<progress>` and `[attr.value]`

```html
<progress id="file-progress" max="100" [attr.value]="percent()"></progress>
```

A `<progress>` **without** a `value` attribute is indeterminate (an animated bar). `[attr.value]` binds the ATTRIBUTE,
and binding `null` removes it — exactly what we want while `total` is unknown. `[value]` would bind the DOM property,
and `null` would become `0`. When `loaded` reaches `total`, the bytes are sent but the server is still checking them
(sniffing, hashing, the duplicate check): the label changes from "Envoi du fichier…" to "Vérification par le
serveur…" so the bar at 100 % does not look stuck.

## 9. The Dossier tab

`features/employees/employee-file-tab.ts` is a tab of the employee page (`employee_file.read`), created only when
shown (`@switch`, like the Leave and Documents tabs, chapter 14). What it shows comes from the server:

- `_actions` of the **list** (`upload`, `upload_medical`): the "Add a document" button, and whether the medical category
  is offered (`uploadableCategories()`).
- `_actions` of **each file** (`delete`): its Delete button.
- `_redacted: ['medical']`: this caller may not see medical files — any there are, are ABSENT from `items`. The API sets
  it whether or not medical files exist (saying "there are some" would itself leak medical data), so the tab says
  "medical documents, if any, are not shown" instead of pretending the file is complete (chapter 12's `_redacted` idea).
- `Session.can('employee_file.delete')` is only used for the "show deleted documents" switch: `includeDeleted` is a list
  option the API ignores without that permission, not an authorization.

Two resources feed one `computed()`: `files` (keyed on the employee and the switch) and `categories` (their order and
labels); `groups = computed(() => groupByCategory(items(), categories()))`.

**`<details>` / `<summary>`** make the groups collapsible with no component state: the browser handles the toggle,
keyboard and screen readers. Because `@for` tracks the groups by category id, a reload after an upload keeps the same
`<details>` elements — the groups the user closed stay closed.

**One card per file at every width.** A table of seven columns does not fit 390 px; the cards lay out as a row on
desktop (`grid-template-columns: auto minmax(0, 1fr) auto`) and let the buttons wrap under the text on phones. One
markup, one media query (`employee-file.css`).

**Downloads** reuse chapter 18: `providers: [BlobFiles]`, `files.save(api.content(…), downloadFileName(f.originalFilename,
f.mime))`. A Blob saved through `<a download="…">` gets the name **the app** gives — the API's `Content-Disposition` is
not used — so the app applies the API's rule itself (`employee-files.models.ts`): the extension must match the type the
API **detected**, else it is added (`page.html` holding a PDF is saved as `page.html.pdf`; saved as `page.html`, a
PDF/HTML polyglot would run its script when opened from the disk). Files are never opened in a tab: the API serves them as attachments with `Content-Security-Policy: sandbox` because they are
not scanned for viruses (contract assumption 13). `<bdi>` isolates each file name so an Arabic name in a French line
(or the reverse) does not reorder the text around it.

## 10. Confirm before delete

The delete dialog is the native `<dialog>` of the "End employment" dialog (chapter 02): `showModal()` makes the page
inert and traps focus, Escape and Cancel close it with nothing sent, `(close)` resets the state however it was closed.
What makes it a *confirmation*:

- it names the document (`<strong>{{ f.title }}</strong>`) and says what happens (the bytes are erased, the trace stays
  in the history);
- a **reason** is required (3–500 characters, `trimmedLength(3, 500)` — spaces alone do not count) and kept in the audit
  trail;
- the only confirming control is a `btn danger` "Supprimer définitivement";
- the per-card buttons carry an accessible name with the title (`[attr.aria-label]="'Supprimer « ' + title + ' »'"`),
  so a screen-reader list of buttons says WHICH document.

A 409 `employee-file-deleted` (someone else was faster) is explained in the dialog and the list is reloaded behind it.

## 11. Formatting sizes

`{{ f.sizeBytes | fileSize: lang() }}` (`shared/file-size/file-size.pipe.ts`) — "244 ko", "2,5 Mo", "2.5 MB", and the
Arabic unit names. A pure pipe re-runs only when its value or an argument changes, so passing `lang()` re-formats on a
language switch (the `relativeTime` pipe's pattern, chapter 16). It uses `Intl.NumberFormat(locale, { style: 'unit',
unit: 'megabyte' })`: Angular's locale data has no unit names, the browser's `Intl` has them; the locale ids are the
date ones (`fr`, `ar-DZ` with Latin digits, `en-US`).

Under 1 kB the unit is written in full (`unitDisplay: 'long'`): the short English unit has
no plural ("800 byte"), the long one follows each language's CLDR plural rules — "1 byte" /
"800 bytes", "1 octet" / "800 octets", and the Arabic form the browser's data gives. No
"(s)" by hand and no plural table of our own: `Intl.NumberFormat` applies the plural
rules itself. kB and MB stay short ("244 kB", "2,5 Mo").

## 12. Testing uploads

- **Replace the upload client** in TestBed: `{ provide: UPLOAD_HTTP_CLIENT, useExisting: HttpClient }`
  (`provideUploadsThroughTestingBackend()`, `src/testing/employee-file-fixtures.ts`). The real token builds its own
  XHR backend, which `HttpTestingController` would not see.
- **Progress**: `req.event({ type: HttpEventType.UploadProgress, loaded: 1024, total: 2048 })` pushes an event through
  the chain before `req.flush(body, { status: 201 })`; the testing backend emits `Sent` first by itself.
- **Abort**: unsubscribe, then `expect(req.cancelled).toBe(true)`.
- **The real client** (`employee-files-api.spec.ts`, "UPLOAD_HTTP_CLIENT"): provide a fake `XhrFactory` in the root
  injector — the child injector finds it in its parent — set an `XSRF-TOKEN` cookie, post, and check that the fake XHR
  got the `X-XSRF-TOKEN` header and an `upload` progress listener: the child really has the app's features.
- **Files in jsdom**: `new File([new Uint8Array(size)], name, { type })`; set `input.files` with
  `Object.defineProperty(input, 'files', { value: [file] })` and dispatch `change`. For a drop, dispatch a cancelable
  `Event('drop')` with a `dataTransfer` property, then assert `event.defaultPrevented`.
- **Multipart bodies**: `(req.request.body as FormData).get('title')`, and `[...form.keys()]` for the field order
  (text fields before the file — multer only knows the fields that came before the file part).
