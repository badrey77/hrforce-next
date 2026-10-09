import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { loadErrorKey } from './recruitment-view';

/**
 * The Law 18-07 information notice HR hands to candidates: the French and the Arabic text one under the other,
 * whatever the UI language (the reader is the candidate, not the user). The app chrome is hidden when printing
 * (`@media print` in app.css); this page hides its own controls.
 */
@Component({
  selector: 'app-recruitment-notice-page',
  imports: [TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <div class="screen-only">
        <p><a routerLink="/recruitment">{{ t('recruitment.openings.back') }}</a></p>
        <header class="page-header">
          <h1>{{ t('recruitment.notice.title') }}</h1>
          <button class="btn" type="button" data-action="print" [disabled]="!policy.hasValue()" (click)="print()">{{ t('recruitment.notice.print') }}</button>
        </header>
        <p class="field-hint">{{ t('recruitment.notice.hint') }}</p>
      </div>
      @if (policy.hasValue()) {
        @let p = policy.value();
        <article class="notice" data-panel="notice">
          <section lang="fr" dir="ltr" data-lang="fr">
            <h2>{{ t('recruitment.notice.headingFr') }}</h2>
            <p>{{ t('recruitment.notice.textFr', { company: p.company.nameFr, months: p.retentionMonths }) }}</p>
          </section>
          <section lang="ar" dir="rtl" data-lang="ar">
            <h2>{{ t('recruitment.notice.headingAr') }}</h2>
            <p>{{ t('recruitment.notice.textAr', { company: p.company.nameAr || p.company.nameFr, months: p.retentionMonths }) }}</p>
          </section>
        </article>
      } @else if (policy.error()) {
        <div class="form-error" role="alert">
          <p>{{ t(errorKey()) }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
  styles: `
    .notice {
      max-inline-size: 44rem;
      padding: var(--space-6);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      font-size: 1.0625rem;
      line-height: 1.8;
    }
    .notice section + section { margin-block-start: var(--space-6); }
    .notice h2 { margin-block: 0 var(--space-3); font-size: 1.25rem; }
    .notice [lang='ar'] { font-family: var(--font-arabic); }
    @media print {
      .screen-only { display: none; }
      .notice { border: 0; padding: 0; max-inline-size: none; }
    }
  `,
})
export class NoticePage {
  private readonly view = inject(DOCUMENT).defaultView;
  protected readonly policy = inject(RecruitmentApi).policyResource();
  protected readonly errorKey = computed(() => loadErrorKey(this.policy.error(), 'recruitment.settings.loadError'));

  protected print(): void {
    this.view?.print();
  }
}
