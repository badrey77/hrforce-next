/**
 * `<app-sso-connect-panel [client]="view" />` — « Comment connecter l'application »: what the app's developer types in
 * their OpenID Connect library (docs/contracts/sso.md › Web): issuer, discovery URL, client id, redirect URIs and the
 * scopes to ask for, each with a « Copier » button. The secret is NOT here (it is shown once, at creation/rotation).
 *
 * Angular concepts:
 * - **Derived rows with `computed()`**: the list of (label, value) pairs is computed from the `client` input, so the
 *   template is one `@for`; a new view (after a save) recomputes it.
 * - **Per-row feedback in one signal**: `copied` holds the key of the last copied row, and the row compares itself
 *   with it — no per-row state object. `aria-live` on the row's hint announces « Copié. » to screen readers.
 * - Values are URLs and identifiers: `dir="ltr"` + `<code>` so they read the same in the Arabic UI.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { copyText } from '../../core/browser/clipboard';
import { SSO_SCOPES, type SsoClientView } from '../../core/sso/sso.models';

interface ConnectRow {
  readonly key: string;
  readonly value: string;
}

@Component({
  selector: 'app-sso-connect-panel',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" class="panel" aria-labelledby="sso-connect-title" data-section="connect">
      <h3 id="sso-connect-title">{{ t('sso.connect.title') }}</h3>
      <p class="muted">{{ t('sso.connect.intro') }}</p>
      <dl class="connect">
        @for (row of rows(); track row.key + row.value) {
          <dt>{{ t('sso.connect.' + row.key) }}</dt>
          <dd [attr.data-row]="row.key">
            <code dir="ltr">{{ row.value }}</code>
            <button class="btn secondary small" type="button" (click)="copy(row)">
              {{ t('sso.connect.copy') }}<span class="visually-hidden"> — {{ t('sso.connect.' + row.key) }}</span>
            </button>
            <span class="field-hint" aria-live="polite">{{ copied() === row.key + row.value ? t('sso.connect.copied') : '' }}</span>
          </dd>
        }
      </dl>
    </section>
  `,
  styles: `
    .connect { display: grid; gap: var(--space-1); margin: 0; }
    .connect dt { color: var(--color-text-muted); margin-block-start: var(--space-2); }
    .connect dd { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
    .connect code { overflow-wrap: anywhere; font-family: var(--font-mono); }
    .small { padding-block: 0; padding-inline: var(--space-2); }
  `,
})
export class SsoConnectPanel {
  readonly client = input.required<SsoClientView>();

  protected readonly rows = computed<readonly ConnectRow[]>(() => {
    const client = this.client();
    return [
      { key: 'issuer', value: client.issuer },
      { key: 'discovery', value: `${client.issuer}/.well-known/openid-configuration` },
      { key: 'clientId', value: client.clientId },
      ...client.redirectUris.map((value) => ({ key: 'redirectUri', value })),
      ...client.postLogoutRedirectUris.map((value) => ({ key: 'postLogoutRedirectUri', value })),
      { key: 'scopes', value: SSO_SCOPES },
    ];
  });

  protected readonly copied = signal<string | null>(null);

  protected async copy(row: ConnectRow): Promise<void> {
    this.copied.set((await copyText(row.value)) ? row.key + row.value : null);
  }
}
