/**
 * /settings/branding — « Identité visuelle » (docs/contracts/branding.md › Settings section; `settings.branding`).
 * Two tabs over one `GET /branding/settings`: the installation default (only for the owning company, i.e. when the
 * API sends `installation`) and the caller's company. After every successful write the session is read again, so
 * the header, the tab title, the colour and the dashboard follow at once.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../../core/auth/session';
import { BrandingApi } from '../../../core/branding/branding-api';
import type { BrandingSettingsView } from '../../../core/branding/branding.models';
import { SettingsNav } from '../settings-nav';
import { BrandingForm } from './branding-form';
import type { BrandingLevel } from './branding-forms';

@Component({
  selector: 'app-branding-page',
  imports: [TranslocoDirective, SettingsNav, BrandingForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <app-settings-nav />
      <h2 id="branding-title">{{ t('branding.title') }}</h2>

      @if (settings.error() && !settings.hasValue()) {
        <div class="form-error" role="alert" data-error="load">
          <p>{{ t('branding.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="settings.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (view(); as v) {
        @if (readOnly()) {
          <p class="warning" role="status" data-state="read-only">{{ t('branding.readOnly') }}</p>
        }
        @if (v.installation) {
          <div class="tabs" role="tablist" [attr.aria-label]="t('branding.tabs.label')" (keydown.arrowleft)="other($event)" (keydown.arrowright)="other($event)">
            @for (level of levels; track level) {
              <button
                type="button"
                role="tab"
                [id]="'branding-tab-' + level"
                [attr.aria-selected]="tab() === level"
                [attr.aria-controls]="'branding-panel-' + level"
                [attr.tabindex]="tab() === level ? 0 : -1"
                [class.active]="tab() === level"
                [attr.data-tab]="level"
                (click)="chosen.set(level)"
              >
                {{ t('branding.tabs.' + level) }}
              </button>
            }
          </div>
          <div role="tabpanel" id="branding-panel-installation" aria-labelledby="branding-tab-installation" [hidden]="tab() !== 'installation'">
            <app-branding-form level="installation" [view]="v" [readOnly]="readOnly()" (scopeRefused)="readOnly.set(true)" (saved)="onSaved($event)" (reload)="onReload()" />
          </div>
          <div role="tabpanel" id="branding-panel-company" aria-labelledby="branding-tab-company" [hidden]="tab() !== 'company'">
            <app-branding-form level="company" [view]="v" [readOnly]="readOnly()" (scopeRefused)="readOnly.set(true)" (saved)="onSaved($event)" (reload)="onReload()" />
          </div>
        } @else {
          <!-- Not the owning company: the installation default is neither shown nor editable here. -->
          <h3 class="only">{{ t('branding.tabs.company') }}</h3>
          <app-branding-form level="company" [view]="v" [readOnly]="readOnly()" (scopeRefused)="readOnly.set(true)" (saved)="onSaved($event)" (reload)="onReload()" />
        }
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
  styles: `
    h2 { margin-block: 0 var(--space-3); font-size: 1.25rem; }
    .only { margin-block: 0 var(--space-2); font-size: 1.125rem; }
    .tabs { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-block-end: var(--space-4); }
    [role='tab'] { padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text); cursor: pointer; }
    [role='tab']:hover { background: var(--color-hover); }
    [role='tab'].active { border-color: var(--color-primary); background: var(--color-primary); color: var(--color-on-primary); font-weight: 600; }
  `,
})
export class BrandingPage {
  private readonly session = inject(Session);

  protected readonly settings = inject(BrandingApi).settingsResource();
  protected readonly view = computed<BrandingSettingsView | undefined>(() => (this.settings.hasValue() ? this.settings.value() : undefined));
  protected readonly levels: readonly BrandingLevel[] = ['installation', 'company'];
  /** The tab picked by the user; until then the first one available. */
  protected readonly chosen = signal<BrandingLevel | null>(null);
  /**
   * The API lets a holder of the permission on part of the company read the settings, and answers every write with
   * 403 `forbidden-scope`. The web cannot tell beforehand (scopes name units, not "the whole company"), so the page
   * turns read-only at the first such refusal.
   */
  protected readonly readOnly = signal(false);
  protected readonly tab = computed<BrandingLevel>(() => (this.view()?.installation ? (this.chosen() ?? 'installation') : 'company'));

  /** Arrow keys move between the two tabs (and the focus with them). */
  protected other(event: Event): void {
    const next: BrandingLevel = this.tab() === 'installation' ? 'company' : 'installation';
    this.chosen.set(next);
    const list = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    list?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
    event.preventDefault();
  }

  protected onSaved(view: BrandingSettingsView): void {
    this.settings.set(view);
    void this.session.load();
  }

  protected onReload(): void {
    this.settings.reload();
    void this.session.load();
  }
}
