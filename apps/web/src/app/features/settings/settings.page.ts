/**
 * /settings ("Paramètres") — for now one section, **Notifications**: an email on/off switch per notification type,
 * with the default shown next to each (docs/contracts/notifications.md › Web; `GET`/`PUT /me/notification-preferences`).
 * In-app notifications cannot be turned off (the contract has only an `email` flag).
 *
 * Angular concepts:
 * - **`linkedSignal()` as an editable copy of server data.** `choices` starts as the server's preferences and the
 *   checkboxes change it locally; when the resource answers again (first load, reload after a save) the linked signal
 *   recomputes and the edits are replaced by the saved truth. That is `linkedSignal`'s job: "derived, but writable in
 *   between". A reactive form would work too (a `FormRecord<FormControl<boolean>>` rebuilt when the data arrives, via
 *   an `effect()`), but the form would have to be kept in sync by hand; here the derivation IS the sync.
 * - **Dirty state as a `computed()`**: `dirty` compares the choices with the server's values, so "Save" is enabled
 *   only when something changed, and flipping a box back makes the page clean again (a form's `dirty` flag would stay
 *   true).
 * - **A resource is writable**: after a successful PUT the page `set()`s the resource's value to what it sent, instead
 *   of asking the server again (`reload()` would work too, at the cost of a GET and a moment where the old values show).
 * - **`(submit)` without FormsModule**: no Angular forms module is imported, so nothing intercepts the native submit;
 *   `$event.preventDefault()` stops the browser from navigating, and Enter / the submit button still both save.
 * - **Save state as signals**: `saving` disables the button (no double PUT), `feedback` is a `role="status"` message,
 *   `saveError` a `role="alert"` one; a 422 (the server refused a type/value) gets its own explanation.
 * - **Labels by convention**: `notifications.typeLabels.<type>` — a type the web does not know yet still shows its code.
 */
import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { NotificationsApi } from '../../core/notifications/notifications-api';
import type { NotificationPreference } from '../../core/notifications/notifications.models';

type Choices = Readonly<Record<string, boolean>>;

function choicesOf(preferences: readonly NotificationPreference[]): Choices {
  return Object.fromEntries(preferences.map((p) => [p.type, p.email]));
}

/** Translation key for a failed save. */
export function preferencesErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'settings.notifications.saveError';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 422 || error.status === 400) return 'settings.notifications.invalid';
  return 'settings.notifications.saveError';
}

@Component({
  selector: 'app-settings-page',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <header class="page-header">
        <h1>{{ t('settings.title') }}</h1>
      </header>

      <section class="panel" aria-labelledby="settings-notifications-title" [attr.aria-busy]="preferences.isLoading()">
        <h2 id="settings-notifications-title">{{ t('settings.notifications.title') }}</h2>
        <p class="muted">{{ t('settings.notifications.intro') }}</p>

        @if (preferences.error() && !preferences.hasValue()) {
          <div class="form-error" role="alert">
            <p>{{ t('settings.notifications.loadError') }}</p>
            <button class="btn secondary" type="button" (click)="preferences.reload()">{{ t('common.retry') }}</button>
          </div>
        } @else if (preferences.hasValue()) {
          <form (submit)="$event.preventDefault(); save()" novalidate>
            <fieldset class="prefs">
              <legend class="visually-hidden">{{ t('settings.notifications.email') }}</legend>
              @for (pref of items(); track pref.type) {
                @let labelKey = 'notifications.typeLabels.' + pref.type;
                @let label = t(labelKey);
                <label class="check" [attr.data-pref]="pref.type">
                  <input type="checkbox" [checked]="choices()[pref.type]" (change)="toggle(pref.type, $event)" />
                  <span>
                    {{ label === labelKey ? pref.type : label }}
                    <span class="muted default">
                      ({{ t(pref.default ? 'settings.notifications.defaultOn' : 'settings.notifications.defaultOff') }})
                    </span>
                  </span>
                </label>
              }
            </fieldset>

            @if (saveError(); as key) {
              <p class="form-error" role="alert" data-error="save">{{ t(key) }}</p>
            }
            <p class="muted" role="status" data-state="feedback">
              @if (feedback(); as key) {
                {{ t(key) }}
              } @else if (dirty()) {
                {{ t('settings.notifications.unsaved') }}
              }
            </p>
            <div class="form-actions">
              <button class="btn" type="submit" data-action="save" [disabled]="!dirty() || saving()">
                {{ t(saving() ? 'settings.notifications.saving' : 'settings.notifications.save') }}
              </button>
              <button class="btn secondary" type="button" data-action="defaults" [disabled]="saving()" (click)="restoreDefaults()">
                {{ t('settings.notifications.restoreDefaults') }}
              </button>
            </div>
          </form>
        } @else {
          <p class="muted">{{ t('common.loading') }}</p>
        }
      </section>
    </ng-container>
  `,
  styles: `
    .prefs { display: grid; gap: var(--space-2); margin: 0 0 var(--space-3); padding: 0; border: 0; }
    .default { font-size: 0.8125rem; }
  `,
})
export class SettingsPage {
  private readonly api = inject(NotificationsApi);

  protected readonly preferences = this.api.preferencesResource();
  protected readonly items = computed<readonly NotificationPreference[]>(() =>
    this.preferences.hasValue() ? this.preferences.value() : [],
  );
  private readonly saved = computed(() => choicesOf(this.items()));
  /** The checkboxes: the server's values, edited locally until saved (see header). */
  protected readonly choices = linkedSignal<Choices>(() => this.saved());
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const choices = this.choices();
    return Object.keys(choices).some((type) => choices[type] !== saved[type]);
  });

  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);

  protected toggle(type: string, event: Event): void {
    const checked = event.target instanceof HTMLInputElement && event.target.checked;
    this.choices.update((choices) => ({ ...choices, [type]: checked }));
    this.feedback.set(null);
  }

  protected restoreDefaults(): void {
    this.choices.set(Object.fromEntries(this.items().map((p) => [p.type, p.default])));
    this.feedback.set(null);
  }

  protected save(): void {
    if (!this.dirty() || this.saving()) return;
    const choices = this.choices();
    const next = this.items().map((p) => ({ ...p, email: choices[p.type] ?? p.email }));
    const body = next.map((p) => ({ type: p.type, email: p.email }));
    this.saving.set(true);
    this.saveError.set(null);
    this.feedback.set(null);
    this.api.savePreferences(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('settings.notifications.saved');
        // What we sent IS the new truth: write it into the resource (a local value, no second GET). `saved` and so
        // `choices` recompute from it and the page is clean again.
        this.preferences.set(next);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.saveError.set(preferencesErrorKey(error));
      },
    });
  }
}
