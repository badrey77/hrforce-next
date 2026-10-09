import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import type { KnownPersonView } from '../../core/recruitment/recruitment.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';

/** « Déjà employé(e) dans l'entreprise : … » — the former (or current) employee a candidate matches. */
@Component({
  selector: 'app-known-person-note',
  imports: [TranslocoDirective, RouterLink, DatePipe, DisplayNamePipe, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let k = known();
      @let e = k.latestEmployment;
      <strong>{{ t('recruitment.known.title') }}</strong>
      <span data-field="known-person">
        <bdi>{{ k.person | displayName: lang() }}</bdi> —
        {{ t('recruitment.known.matricule', { matricule: e.matricule }) }},
        <bdi>{{ e.unit | displayName: lang() }}</bdi>,
        @if (e.endDate) {
          {{ t('recruitment.known.left', { date: (e.endDate | date: 'mediumDate' : undefined : locale()) }) }}
        } @else {
          {{ t('recruitment.known.since', { date: (e.hireDate | date: 'mediumDate' : undefined : locale()) }) }}
        }
      </span>
      <a *appCan="'employee.read'" [routerLink]="['/employees', e.id]">{{ t('recruitment.known.open') }}</a>
      @if (k.hasOpenEmployment) {
        <span class="field-hint" data-state="open-employment">{{ t('recruitment.known.openEmployment') }}</span>
      }
    </ng-container>
  `,
  styles: `
    :host { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
  `,
})
export class KnownPersonNote {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  readonly known = input.required<KnownPersonView>();
}
