/**
 * /documents/settings (`document.configure`) — Letterhead · Signatories · Types, as tabs. Only data is configured
 * here; the legal wording of each document is fixed in the API's templates (ADR 008).
 *
 * Angular concepts:
 * - **Tabs as a local signal** (chapter 14), and each tab a self-contained section component that owns its resource,
 *   form and feedback (the /leave/settings pattern). `@switch` renders only the active one, so opening the settings
 *   loads only the letterhead; the signatories and types are requested when their tab is opened.
 * - **`?tab=` as an entry point**: the issue page's "complete the letterhead" link lands on the default tab; a `tab`
 *   query param (bound as an input, `linkedSignal` of it) lets other links open another tab. Clicking a tab does not
 *   rewrite the URL: the parameter says where to START (the /tasks page's reasoning).
 * - **Writes need the permission over the WHOLE company** (contract › Scope): a unit-scoped holder can read these tabs
 *   but every save answers 403 `forbidden-scope`, which the sections translate ("only a company-wide administrator…").
 */
import { ChangeDetectionStrategy, Component, input, linkedSignal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';
import { ProfileSettings } from './profile-settings';
import { SignatoriesSettings } from './signatories-settings';
import { TypesSettings } from './types-settings';

export type SettingsTab = 'profile' | 'signatories' | 'types';
export const SETTINGS_TABS: readonly SettingsTab[] = ['profile', 'signatories', 'types'];

@Component({
  selector: 'app-document-settings-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, ProfileSettings, SignatoriesSettings, TypesSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './documents.css',
  template: `
    <ng-container *transloco="let t">
      <p *appCan="'document.read'"><a routerLink="/documents">{{ t('documents.detail.back') }}</a></p>
      <header class="page-header">
        <h1>{{ t('documents.settings.title') }}</h1>
      </header>
      <p class="field-hint">{{ t('documents.settings.intro') }}</p>

      <div class="tabs" role="tablist" [attr.aria-label]="t('documents.settings.tabs')">
        @for (name of tabs; track name) {
          <button type="button" role="tab" [id]="'settings-tab-' + name" [attr.data-tab]="name"
            [attr.aria-selected]="active() === name" aria-controls="settings-panel" (click)="active.set(name)">
            {{ t('documents.settings.tab.' + name) }}
          </button>
        }
      </div>
      <div id="settings-panel" role="tabpanel" [attr.aria-labelledby]="'settings-tab-' + active()">
        @switch (active()) {
          @case ('profile') {
            <app-document-profile-settings />
          }
          @case ('signatories') {
            <app-document-signatories-settings />
          }
          @case ('types') {
            <app-document-types-settings />
          }
        }
      </div>
    </ng-container>
  `,
})
export class DocumentSettingsPage {
  protected readonly tabs = SETTINGS_TABS;
  /** `?tab=signatories|types` (bound by the router). */
  readonly tab = input<string | undefined>();
  protected readonly active = linkedSignal<string | undefined, SettingsTab>({
    source: this.tab,
    computation: (tab) => (SETTINGS_TABS as readonly string[]).includes(tab ?? '') ? (tab as SettingsTab) : 'profile',
  });
}
