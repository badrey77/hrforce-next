# 17. Multi-step UI: wizards and two-step sign-in

See also: [03-signals-and-state.md](./03-signals-and-state.md) (signals, `computed`, `linkedSignal`),
[05-routing.md](./05-routing.md) (guards, `UrlTree`), [06-http-and-errors.md](./06-http-and-errors.md)
(interceptors and their order), [07-forms.md](./07-forms.md) (validators, `ControlValueAccessor`),
[11-app-initializers-and-auth-flow.md](./11-app-initializers-and-auth-flow.md) (the sign-in flow this chapter
extends).

The MFA slice (`docs/contracts/mfa.md`) adds three kinds of "more than one screen" UI:

- the login page gets a **second step** (a 6-digit code from an authenticator app, or a recovery code);
- `/me/security` hosts an **enrollment wizard** (intro → scan → confirm → recovery codes);
- **enforcement** sends users who must enroll to that wizard, from any page, and brings them back afterwards.

Files: `src/app/features/auth/login.page.ts|html`, `src/app/features/security/*`,
`src/app/core/auth/mfa-enrollment.ts`, `src/app/core/auth/one-time-code.ts`, `src/app/core/browser/*`.

1. [Steps as state or as routes?](#1-steps-as-state-or-as-routes)
2. [A wizard is a state machine: one signal, a discriminated union, `@switch`](#2-a-wizard-is-a-state-machine)
3. [Focus management between steps](#3-focus-management-between-steps)
4. [One-time-code inputs and auto-submit](#4-one-time-code-inputs-and-auto-submit)
5. [Showing a QR code: `[src]`, data URLs and the sanitizer](#5-showing-a-qr-code-src-data-urls-and-the-sanitizer)
6. [Copy and Download: Clipboard API and Blob URLs](#6-copy-and-download-clipboard-api-and-blob-urls)
7. [`model()`: a checkbox shared by parent and child](#7-model-a-checkbox-shared-by-parent-and-child)
8. [Enforcement: a guard for what we know, an interceptor for what we learn](#8-enforcement-a-guard-and-an-interceptor)
9. [Testing multi-step UI](#9-testing-multi-step-ui)

## 1. Steps as state or as routes?

Angular gives you two ways to show "step 2": navigate to another route (`/login/code`), or keep one component and
change a signal. The login page uses a signal:

```ts
// features/auth/login.page.ts
protected readonly step = signal<LoginStep>('password');   // 'password' | 'code'
```

| Question | Route per step | Signal in one component |
|---|---|---|
| Can the user bookmark / reload it? | yes | no (reload starts over) |
| Do Back/Forward move between steps? | yes | no — Back leaves the page |
| How does step 2 get step 1's data? | URL params, a service, or history state | it is already in the component (the email in the form) |
| Does the step make sense on its own? | must | need not |

The code step only works while the 5-minute `hrf_mfa` cookie from THIS password step exists. A bookmarkable
`/login/code` would be a page that is broken most of the time, and "Back" into a dead step is confusing. So: **a route
for places a user may come back to; a signal for phases of one task.** The Employees detail tabs (chapter 14) follow
the same reasoning, while `/me/security` itself *is* a route, because the enforcement guard must be able to send
people there.

## 2. A wizard is a state machine

`features/security/mfa-enroll-wizard.ts` keeps the whole wizard in one signal whose type is a **discriminated union**:

```ts
export type WizardState =
  | { readonly step: 'intro' }
  | { readonly step: 'scan'; readonly enrollment: MfaEnrollment }
  | { readonly step: 'confirm'; readonly enrollment: MfaEnrollment }
  | { readonly step: 'codes'; readonly codes: readonly string[] };

protected readonly state = signal<WizardState>({ step: 'intro' });
```

Each state carries exactly the data its step needs. "Showing codes but there are none" or "scanning without a QR" are
not representable, so neither the class nor the template handles them. Compare with the booleans you might start
with (`scanning`, `confirming`, `showCodes`, `enrollment?`, `codes?`): nothing stops two of them being true at once.

Transitions are methods, and only `go()` writes the signal:

```
intro ──start()──▶ [POST enroll/start] ──▶ scan ──toConfirm()──▶ confirm ──confirm()──▶ [POST enroll/confirm] ──▶ codes ──finish()──▶ (finished)
                                            ▲                       │
                                            └──────── back() ───────┘
```

The template switches on the tag:

```html
@switch (state().step) {
  @case ('intro') { … }
  @case ('scan') { <img [src]="qrSrc()" …> … }
  @case ('confirm') { <form …> … </form> }
  @case ('codes') { <app-recovery-codes [codes]="codes()" [(saved)]="codesSaved" /> … }
}
```

`@switch` renders exactly one `@case`; the others' DOM does not exist. The payload is read through small `computed()`s
(`enrollment`, `codes`) that return `null` / `[]` outside their steps — simple, type-safe, and no casts in the
template. The progress list is derived too: `stepNumber = computed(() => NUMBERED_STEPS.indexOf(state().step) + 1)`
drives `aria-current="step"` and the "done" styling.

When a machine grows (parallel regions, guards on transitions, history), a library such as XState earns its place.
Four states and five transitions do not need one: a union type plus `signal()` is the state machine.

## 3. Focus management between steps

When `@switch` swaps a step, the focused element (the button the user just pressed) is destroyed. The browser then
moves focus to `<body>`: a keyboard user starts again from the top of the page and a screen reader says nothing about
the new step. So every transition ends with:

```ts
private go(next: WizardState): void {
  this.state.set(next);
  this.focusAfterRender(() => (next.step === 'confirm' ? this.codeInput() : this.stepHeading()));
}

private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
  afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
}
```

- `afterNextRender()` runs **once, after Angular has rendered** the change — by then the new step's elements exist.
  (An `effect()` could run before the DOM is updated.) Called outside the constructor, it needs the component's
  `Injector`.
- `viewChild('stepHeading')` finds whichever `<h3 #stepHeading>` the active `@case` rendered — each step has one.
  The heading has `tabindex="-1"`: focusable by code, not added to the Tab order. Focusing a heading makes screen
  readers announce it ("Scannez ce code QR, titre niveau 3").
- The confirm step focuses its **input** instead: the only thing to do there is type.
- The login page does the same between its steps, and puts focus back on the password field when the challenge
  expired.

## 4. One-time-code inputs and auto-submit

```html
<input id="login-code" formControlName="code"
       type="text" inputmode="numeric" autocomplete="one-time-code"
       pattern="[0-9 ]*" maxlength="7" dir="ltr" />
```

- `type="text"` + `inputmode="numeric"`: a digit keypad on phones, without `type="number"`'s spinners, scroll-wheel
  changes and number parsing (a code is a string; `012345` must keep its leading zero).
- `autocomplete="one-time-code"`: lets the browser/OS offer the code (SMS, password managers with TOTP).
- `dir="ltr"`: digits and recovery codes keep their order in the Arabic UI (chapter 08).
- `maxlength="7"` leaves room for "123 456"; `normalizeTotp()` (core/auth/one-time-code.ts) strips the space and
  the `totpCode` validator checks the result.

**Auto-submit** when six digits are there:

```ts
this.codeForm.controls.code.valueChanges
  .pipe(filter(isCompleteTotp), takeUntilDestroyed(inject(DestroyRef)))
  .subscribe(() => { if (this.step() === 'code' && !this.submitting()) void this.verify(); });
```

Why `valueChanges` rather than a template event:

- `(keyup)` misses paste from the context menu and autofill (they fire `input`, not key events);
- `(input)="…"` would work but would re-implement "is it complete?" in the template, next to the form control that
  already holds the value;
- the control is the single source of the value: whatever changed it — typing, paste, autofill, a test calling
  `setValue` — goes through `valueChanges`.

`takeUntilDestroyed()` unsubscribes with the component. When the server says the code is wrong, the page clears it
with `setValue('', { emitEvent: false })` — without `emitEvent: false` the cleared value would itself pass through
`valueChanges` (harmless here thanks to the filter, but the habit matters when the filter is looser).

Recovery codes are longer and do not auto-submit: the user presses "Verify".

## 5. Showing a QR code: `[src]`, data URLs and the sanitizer

The API sends the QR as `data:image/png;base64,…` (so the web needs no QR library). Binding it is ordinary:

```html
<img class="qr" [src]="src" width="200" height="200" [alt]="t('security.wizard.scan.qrAlt')" />
```

Angular treats `[src]`, `[href]` and friends as **URL contexts**: every bound value goes through its URL sanitizer,
which neutralises script-capable schemes (`javascript:` becomes `unsafe:javascript:…`). `data:image/png` is allowed,
so no `DomSanitizer.bypassSecurityTrustUrl()` is needed — and none should be used: "bypass" means *I have proven this
value safe*, and it silences the protection for everything that ever flows through that binding.

The wizard adds one more line of defence: `qrSrc` returns the value only if it matches
`^data:image/png;base64,[A-Za-z0-9+/=]+$`. The page therefore never loads an arbitrary URL the API might send (a
tracking pixel, another origin). The test "does not render a QR that is not a PNG data URL" pins that down. The CSP
must allow `img-src data:` (the contract's note for `deploy/Caddyfile`).

## 6. Copy and Download: Clipboard API and Blob URLs

**Copy** — `core/browser/clipboard.ts`:

```ts
await navigator.clipboard.writeText(text);
```

It needs a secure context and usually a user gesture (it runs from a click), and it can still refuse. `copyText()`
resolves `false` instead of throwing, and the component shows "select the text and copy it" in a `role="status"`
region. The codes are always visible too, so nothing depends on the clipboard.

**Download** — `core/browser/download.ts`:

```ts
const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
const a = doc.createElement('a');
a.href = url; a.download = 'hrforce-recovery-codes.txt'; a.hidden = true;
doc.body.append(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(url), 0);
```

Why this is acceptable in an Angular app that otherwise never touches the DOM by hand:

- it is **user-initiated** (the "Download" click), so browsers allow it without pop-up prompts;
- the `blob:` URL is **same-origin** and points at bytes the page just built from its own data — nothing is fetched,
  no user-supplied URL is followed;
- the anchor is created in code and removed immediately; it is never part of a template, so Angular's sanitizer
  (which guards template bindings) is not involved and not bypassed;
- `revokeObjectURL` frees the memory once the browser has started the download.

The component injects `DOCUMENT` instead of using the global `document`, and passes it to `downloadText()`: code
that does not assume a browser global is easier to test and to render on a server.

## 7. `model()`: a checkbox shared by parent and child

The recovery codes may leave the screen only once the user ticks "I have saved them". The checkbox lives in the
reusable `<app-recovery-codes>`; the Finish button lives in the wizard (and "Done" on the security page). One piece of
state, two components:

```ts
// recovery-codes.ts
readonly saved = model(false);
protected toggleSaved(event: Event) { this.saved.set(event.target instanceof HTMLInputElement && event.target.checked); }
```

```html
<!-- mfa-enroll-wizard.html -->
<app-recovery-codes [codes]="codes()" [(saved)]="codesSaved" />
<button [disabled]="!codesSaved()" (click)="finish()">Terminer</button>
```

`model()` is an input and an output in one (`saved` + `savedChange`); `[(saved)]="codesSaved"` binds it two-way to the
parent's **signal** (pass the signal itself, not `codesSaved()`). `finish()` re-checks `codesSaved()` — a disabled
button is UI, not a rule. Use `model()` when parent and child truly share state; keep `input()` + `output()` when the
child only reports events (the wizard's `finished` / `cancelled`).

## 8. Enforcement: a guard and an interceptor

The contract: when `me.mfa.required && !me.mfa.enabled`, every page except `/me/security` (and sign-out) leads to the
wizard, and so does a `403 mfa-enrollment-required` from any call. `core/auth/mfa-enrollment.ts` has both halves.

**The guard — for what the session already knows.**

```ts
// app.routes.ts
const signedIn = [authGuard, mfaEnrollmentGuard];
{ path: 'employees', canMatch: [...signedIn, permissionGuard()], … }
{ path: 'me/security', canMatch: [authGuard], … }            // NOT signedIn: this is where people are sent
```

- `canMatch`, like `authGuard`: it runs before any lazy chunk is downloaded (chapter 05).
- Guards in one `canMatch` array run in order and the first non-`true` result wins: a signed-out visitor gets
  `authGuard`'s /login redirect, not the wizard.
- It returns a `UrlTree` — `/me/security?enroll=1&returnUrl=/employees%3Fq%3Dali` — built from
  `router.currentNavigation().extractedUrl`, like `authGuard`'s `returnUrl`. `returnUrl` goes through
  `safeReturnUrl()` both when it is written and when it is used.
- One shared `signedIn` array means a new route cannot "forget" the enforcement guard by accident.

**The interceptor — for what the app learns later.** The policy can change mid-session (an admin enforces it, or
grants a sensitive role). The server then answers `403 mfa-enrollment-required`. `mfaEnrollmentInterceptor` spots
that problem type on any response, and the root `MfaEnforcement` service reloads the session (so the guard agrees
from now on) and navigates to the wizard — once, however many calls failed at the same moment (a flag in the service;
an interceptor function has no state of its own). The error is re-thrown unchanged: callers still fail as usual.
When the session **already** says "must enroll", the service does nothing: the guard is in charge. Right after
sign-in the shell's own calls (task count, bell) fail with this 403 while the first navigation is still in flight and
`router.url` is still the page being left (`/login`); navigating from the interceptor then would overwrite the guard's
correct `returnUrl` with that stale URL (found by the browser verification).

Why a separate interceptor instead of a branch inside `apiProblemInterceptor`: that one only converts errors into
`ApiProblemError` and depends on nothing; this one needs `Router` and `Session`. Different jobs, different files.

**Order.** `withInterceptors([mfaEnrollmentInterceptor, apiProblemInterceptor, authRefreshInterceptor])`: first =
outermost, and responses travel inside-out, so this interceptor sees each error **last** —

- after the refresh interceptor: `401 → refresh → retry → 403 mfa-enrollment-required` is caught (placed inside the
  refresh interceptor it would only see the first 401);
- after the problem interceptor: the error is already parsed (`error.problem.type`).

The refresh interceptor only handles 401 and this one only 403, so they never compete for a response.

**Coming back.** When the wizard emits `finished`, the security page `await`s `Session.load()` *before* navigating to
`returnUrl` — otherwise the guard would still read "required, not enabled" and bounce the user straight back. The
login page needs no special case: after the code step it navigates to its own `returnUrl`, and the guard turns that
into the wizard with the same `returnUrl` when enrollment is required.

## 9. Testing multi-step UI

- **Drive steps through the DOM, assert on the state tag.** The wizard's `<section data-state="scan">` and the login
  form's `data-step` make "which step am I on" one selector. Tests click the same buttons a user would
  (`[data-action="next"]`).
- **Answer each HTTP call in order** with `HttpTestingController`: `POST enroll/start` → flush the enrollment →
  `POST enroll/confirm` → flush codes. `expectNone('/api/auth/mfa/verify')` after five digits proves auto-submit
  waits for six.
- **Focus** is observable: `expect(document.activeElement?.id).toBe('wizard-code')` after the transition settles
  (`afterNextRender` runs during `fixture.whenStable()`).
- **Browser APIs** are stubbed at their edge: `Object.defineProperty(navigator, 'clipboard', …)`,
  `URL.createObjectURL = vi.fn(…)` capturing the `Blob` (then `await blob.text()`), and a spy on
  `HTMLAnchorElement.prototype.click` capturing `download`.
- **Guards and interceptors** are tested with `RouterTestingHarness` and a real `HttpClient` wired with the same
  interceptor list as app.config.ts (`core/auth/mfa-enrollment.spec.ts`), including the 401 → refresh → retry → 403
  path.
- **A component that leaves the page** cancels its resources: after the security page navigates to `returnUrl`, its
  status re-read is cancelled and there is nothing to flush.

Specs: `features/auth/login.page.spec.ts` (two-step block), `features/security/mfa-enroll-wizard.spec.ts`,
`features/security/security.page.spec.ts`, `core/auth/mfa-enrollment.spec.ts`, `core/browser/download.spec.ts`,
`shell/user-menu.spec.ts`, `features/access/user-detail.page.spec.ts` (reset), `features/access/security-policy.page.spec.ts`.
