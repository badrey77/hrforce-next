/**
 * `<app-balance-cards [balances]="items" />` — one card per leave type, one line per reference year: days
 * available (big), then balance, pending, accrued, taken, adjusted. Used by My leave and the employee Leave tab.
 *
 * Angular concepts:
 * - **Presentational component**: data in through an input, nothing fetched. `groups` is a `computed()` that groups
 *   the flat API list by type, keeping the API order (types first seen first). It also reads `LeaveCatalog.nameOf()`
 *   → the language signal, so cards re-label on a language switch.
 * - **`DecimalPipe` with an explicit locale** (`days | number: '1.0-1' : locale()`): days are numeric(5,1); "7,5" in
 *   French, "7.5" in English and Algerian Arabic. The locale is an ARGUMENT (see core/i18n/date-locale.ts: why we never
 *   rely on `LOCALE_ID` in this app), so a language switch re-formats.
 * - **`@let`** declares a template-local variable (`@let low = …`) — read once, used several times below it.
 */
import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LeaveBalance } from '../../core/leave/leave.models';
import { referenceYearLabel } from './leave-forms';

interface BalanceGroup {
  readonly typeId: string;
  readonly name: string;
  readonly rows: readonly LeaveBalance[];
}

@Component({
  selector: 'app-balance-cards',
  imports: [TranslocoDirective, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @if (groups().length) {
        <ul class="cards">
          @for (group of groups(); track group.typeId) {
            <li class="card" [attr.data-type]="group.typeId">
              <h3>{{ group.name }}</h3>
              @for (row of group.rows; track row.periodStart) {
                @let low = row.available <= 0;
                <div class="year" [attr.data-period]="row.periodStart">
                  <p class="year-label">{{ t('leave.balances.year', { year: yearLabel(row.periodStart) }) }}</p>
                  <p class="available" [class.low]="low">
                    <strong>{{ row.available | number: '1.0-1' : locale() }}</strong>
                    {{ t('leave.balances.available') }}
                  </p>
                  <dl class="facts small">
                    <dt>{{ t('leave.balances.balance') }}</dt>
                    <dd>{{ row.balance | number: '1.0-1' : locale() }}</dd>
                    <dt>{{ t('leave.balances.pending') }}</dt>
                    <dd>{{ row.pending | number: '1.0-1' : locale() }}</dd>
                    <dt>{{ t('leave.balances.accrued') }}</dt>
                    <dd>{{ row.accrued | number: '1.0-1' : locale() }}</dd>
                    <dt>{{ t('leave.balances.taken') }}</dt>
                    <dd>{{ row.taken | number: '1.0-1' : locale() }}</dd>
                    @if (row.adjusted) {
                      <dt>{{ t('leave.balances.adjusted') }}</dt>
                      <dd>{{ row.adjusted | number: '1.0-1' : locale() }}</dd>
                    }
                  </dl>
                </div>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="muted" data-state="no-balance">{{ t('leave.balances.empty') }}</p>
      }
    </ng-container>
  `,
  styles: `
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .card { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface-alt); }
    h3 { margin: 0 0 var(--space-2); font-size: 1rem; }
    .year + .year { margin-block-start: var(--space-3); padding-block-start: var(--space-2); border-block-start: 1px solid var(--color-border); }
    .year-label { margin: 0; font-size: 0.8125rem; color: var(--color-text-muted); }
    .available { margin: 0 0 var(--space-1); }
    .available strong { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
    .available.low strong { color: var(--color-danger); }
    .small { font-size: 0.8125rem; margin: 0; }
    dd { font-variant-numeric: tabular-nums; }
  `,
})
export class BalanceCards {
  private readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly balances = input.required<readonly LeaveBalance[]>();

  protected readonly groups = computed<readonly BalanceGroup[]>(() => {
    const byType = new Map<string, LeaveBalance[]>();
    for (const row of this.balances()) {
      const rows = byType.get(row.leaveTypeId) ?? [];
      rows.push(row);
      byType.set(row.leaveTypeId, rows);
    }
    return [...byType].map(([typeId, rows]) => ({
      typeId,
      name: this.catalog.nameOf(typeId),
      rows: rows.toSorted((a, b) => a.periodStart.localeCompare(b.periodStart)),
    }));
  });

  protected readonly yearLabel = referenceYearLabel;
}
