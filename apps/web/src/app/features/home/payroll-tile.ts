/**
 * The dashboard's payroll section (`payroll.read`; docs/contracts/payroll-variables.md › Web builder 2): the month
 * to close next — the previous month while it is still open, else the current one — with its status (« ouverte —
 * clôture à partir du 20/10 » / « clôturée le … ») and a link to /payroll on that month. A current month the API does
 * not list yet is open, its cut-off guessed from the default day until the list says otherwise.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { addDays, algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { PayrollApi } from '../../core/payroll/payroll-api';
import { monthKey, type PeriodSummary } from '../../core/payroll/payroll.models';

/** `YYYY-MM` of the month before `month`. */
export function previousMonth(month: string): string {
  return addDays(`${month}-01`, -1).slice(0, 7);
}

/** The month the tile shows: the previous month while it is open, else the current month (open when not listed). */
export function focusPeriod(items: readonly PeriodSummary[], currentMonth: string, cutoffDay = 20): PeriodSummary {
  const find = (month: string) => items.find((p) => monthKey(p.month) === month);
  const previous = find(previousMonth(currentMonth));
  if (previous?.status === 'open') return previous;
  return (
    find(currentMonth) ?? {
      month: currentMonth,
      status: 'open',
      cutoffDate: `${currentMonth}-${String(cutoffDay).padStart(2, '0')}`,
      version: null,
      closedAt: null,
      closedBy: null,
    }
  );
}

@Component({
  selector: 'app-home-payroll-tile',
  imports: [TranslocoDirective, RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (period(); as p) {
      <section *transloco="let t" class="panel" aria-labelledby="home-payroll-title" data-card="payroll">
        <h2 id="home-payroll-title">{{ t('nav.payroll') }}</h2>
        <p class="payroll-line">
          <a routerLink="/payroll" [queryParams]="{ month: monthOf(p) }" class="action" data-link="payroll" [attr.data-status]="p.status">
            {{ t('payroll.home.month', { month: (p.month.slice(0, 7) + '-01' | date: 'MMMM y' : undefined : locale()) }) }}
          </a>
          <span class="action-note" data-status-text>
            @if (p.status === 'closed') {
              {{ p.closedAt ? t('payroll.home.closedOn', { date: (p.closedAt | date: 'shortDate' : undefined : locale()) }) : t('payroll.home.closed') }}
            } @else if (p.cutoffDate <= today) {
              {{ t('payroll.home.openSince', { date: (p.cutoffDate | date: 'dd/MM' : undefined : locale()) }) }}
            } @else {
              {{ t('payroll.home.openFrom', { date: (p.cutoffDate | date: 'dd/MM' : undefined : locale()) }) }}
            }
          </span>
        </p>
      </section>
    }
  `,
  styles: `
    .payroll-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
    .action { display: inline-block; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-primary); border-radius: var(--radius); color: var(--color-primary); font-weight: 600; text-decoration: none; }
    .action:hover { background: var(--color-primary); color: var(--color-on-primary); }
    .action-note { color: var(--color-text-muted); }
  `,
})
export class HomePayrollTile {
  private readonly session = inject(Session);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly today = algiersToday();
  private readonly currentMonth = this.today.slice(0, 7);
  private readonly api = inject(PayrollApi);
  private readonly year = Number(this.currentMonth.slice(0, 4));
  private readonly previousYear = Number(previousMonth(this.currentMonth).slice(0, 4));
  private readonly periods = this.api.periodsResource(() => (this.session.can('payroll.read') ? this.year : undefined));
  /** In January the previous month belongs to last year's list. */
  private readonly lastYearPeriods = this.api.periodsResource(() =>
    this.session.can('payroll.read') && this.previousYear !== this.year ? this.previousYear : undefined,
  );

  protected readonly period = computed<PeriodSummary | null>(() => {
    if (!this.periods.hasValue()) return null;
    const lastYear = this.lastYearPeriods.hasValue() ? this.lastYearPeriods.value().items : [];
    return focusPeriod([...lastYear, ...this.periods.value().items], this.currentMonth);
  });

  protected monthOf(p: PeriodSummary): string {
    return monthKey(p.month);
  }
}
