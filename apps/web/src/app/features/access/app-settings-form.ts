/**
 * `<app-sso-app-form />` — a connected app's settings: client id, names, redirect URIs, post-logout URIs and the
 * client authentication method (docs/contracts/sso.md › Web). Two modes, like the role editor:
 * - no `client` input → CREATE (`POST /sso/clients`), emits `created` with the one-time secret;
 * - `[client]="view"` → EDIT (`PATCH /sso/clients/:id`), client id read-only, emits `saved`; read-only when the view's
 *   `_actions` lacks `update` (the server's decision: company-wide `sso.manage_apps`).
 *
 * Angular concepts:
 * - **Repeatable rows with a `FormArray`.** `redirectUris` is a `FormArray<FormControl<string>>`: a list of controls
 *   addressed by INDEX. The template walks it with `@for (row of uris.controls; track row)` — tracking the control
 *   OBJECT, not `$index`: removing row 1 must keep row 2's DOM (and its focus, its typed text) instead of re-using
 *   row 1's elements for it. `[formControl]="row"` binds each input to its control directly (rows have no names,
 *   so `formControlName` does not fit); `form.get('redirectUris.2')` still finds a row by its index path.
 *   Adding a row is `array.push(control)`, removing `array.removeAt(i)`; the array's value is always the `string[]`
 *   the API expects.
 * - **`effect()` + `untracked()` to load a view into a form** (as the role editor): when the `client` input changes
 *   (first load, or the page reloaded it after a save), rebuild the arrays to the right length and `reset()` the form.
 * - **`dir="ltr"` on every URI input**: a URL is Latin, left-to-right text even in the Arabic UI; without it the bidi
 *   algorithm moves the `/` and `:` around.
 * - **Radio buttons with reactive forms**: two `<input type="radio" formControlName="clientAuthMethod" [value]="m">`
 *   share one control; its value is the checked one's `[value]`.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { type FormArray, type FormControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { SsoApi } from '../../core/sso/sso-api';
import {
  SSO_AUTH_METHODS,
  type SsoClientAuthMethod,
  type SsoClientCreatedView,
  type SsoClientView,
} from '../../core/sso/sso.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import {
  APP_NAME_MAX,
  CLIENT_ID_PATTERN,
  CLIENT_SLUGS,
  listSize,
  noDuplicates,
  notBlank,
  redirectUri,
  ssoFieldErrorKey,
  ssoProblemToForm,
  URI_LIST_MAX,
} from './sso-forms';

export type UriListName = 'redirectUris' | 'postLogoutRedirectUris';

/** URIs are stored exactly as given (exact matching), only trimmed. */
function uris(list: readonly string[]): string[] {
  return list.map((uri) => uri.trim());
}

@Component({
  selector: 'app-sso-app-form',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-settings-form.html',
  styles: `
    .uri-row { display: flex; gap: var(--space-2); align-items: flex-start; }
    .uri-row input { flex: 1; min-inline-size: 0; }
    fieldset { border: 0; padding: 0; margin: 0 0 var(--space-4); }
    legend { font-weight: 600; margin-block-end: var(--space-1); }
    .radio { display: flex; gap: var(--space-2); align-items: center; margin-block: var(--space-1); }
  `,
})
export class SsoAppForm {
  private readonly api = inject(SsoApi);
  private readonly fb = inject(NonNullableFormBuilder);

  /** The app being edited; absent = create. */
  readonly client = input<SsoClientView>();
  readonly created = output<SsoClientCreatedView>();
  readonly saved = output<SsoClientView>();
  readonly cancelled = output<void>();

  protected readonly isNew = computed(() => this.client() === undefined);
  protected readonly readOnly = computed(() => {
    const client = this.client();
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return client !== undefined && !client._actions.includes('update');
  });
  protected readonly methods = SSO_AUTH_METHODS;
  protected readonly uriLists: readonly UriListName[] = ['redirectUris', 'postLogoutRedirectUris'];
  protected readonly nameMax = APP_NAME_MAX;
  protected readonly uriListMax = URI_LIST_MAX;
  protected readonly fieldErrorKey = ssoFieldErrorKey;

  protected readonly form = this.fb.group({
    clientId: ['', [Validators.required, Validators.pattern(CLIENT_ID_PATTERN)]],
    name: ['', [Validators.required, notBlank, Validators.maxLength(APP_NAME_MAX)]],
    nameAr: ['', [Validators.maxLength(APP_NAME_MAX)]],
    redirectUris: this.fb.array([this.uriControl()], [listSize(1, URI_LIST_MAX), noDuplicates]),
    postLogoutRedirectUris: this.fb.array<FormControl<string>>([], [listSize(0, URI_LIST_MAX), noDuplicates]),
    clientAuthMethod: this.fb.control<SsoClientAuthMethod>('client_secret_basic'),
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly savedNote = signal(false);

  constructor() {
    effect(() => {
      const client = this.client();
      const readOnly = this.readOnly();
      untracked(() => {
        if (client) this.load(client);
        if (readOnly) {
          this.form.disable();
        } else {
          this.form.enable();
          if (client) this.form.controls.clientId.disable(); // immutable
        }
      });
    });
  }

  protected list(name: UriListName): FormArray<FormControl<string>> {
    return this.form.controls[name];
  }

  protected addUri(name: UriListName): void {
    this.list(name).push(this.uriControl());
  }

  protected removeUri(name: UriListName, index: number): void {
    const list = this.list(name);
    list.removeAt(index);
    list.markAsTouched();
  }

  protected submit(): void {
    this.formError.set(null);
    this.savedNote.set(false);
    if (this.readOnly()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const nameAr = value.nameAr.trim();
    const client = this.client();
    this.submitting.set(true);
    if (client) {
      this.api
        .updateClient(client.id, {
          name: value.name.trim(),
          nameAr: nameAr || null,
          redirectUris: uris(value.redirectUris),
          postLogoutRedirectUris: uris(value.postLogoutRedirectUris),
          clientAuthMethod: value.clientAuthMethod,
        })
        .subscribe({
          next: (view) => {
            this.submitting.set(false);
            this.savedNote.set(true);
            this.saved.emit(view);
          },
          error: (error: unknown) => this.fail(error),
        });
      return;
    }
    this.api
      .createClient({
        clientId: value.clientId.trim(),
        name: value.name.trim(),
        ...(nameAr ? { nameAr } : {}),
        redirectUris: uris(value.redirectUris),
        postLogoutRedirectUris: uris(value.postLogoutRedirectUris),
        clientAuthMethod: value.clientAuthMethod,
      })
      .subscribe({
        next: (view) => {
          this.submitting.set(false);
          this.created.emit(view);
        },
        error: (error: unknown) => this.fail(error),
      });
  }

  private fail(error: unknown): void {
    this.submitting.set(false);
    this.formError.set(ssoProblemToForm(this.form, error, CLIENT_SLUGS));
  }

  private uriControl(value = ''): FormControl<string> {
    return this.fb.control(value, [Validators.required, redirectUri]);
  }

  private load(client: SsoClientView): void {
    for (const name of ['redirectUris', 'postLogoutRedirectUris'] as const) {
      const list = this.list(name);
      list.clear();
      for (const uri of client[name]) list.push(this.uriControl(uri));
    }
    this.form.reset({
      clientId: client.clientId,
      name: client.name,
      nameAr: client.nameAr ?? '',
      redirectUris: [...client.redirectUris],
      postLogoutRedirectUris: [...client.postLogoutRedirectUris],
      clientAuthMethod: client.clientAuthMethod,
    });
  }
}
