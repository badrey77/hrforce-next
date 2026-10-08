import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import type { Labels } from '../../core/leave/leave.models';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { type ComparisonRow, RECOMMENDATIONS, type SortDir, sortByAverage } from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { isNotFound, loadErrorKey, stageTone } from './recruitment-view';

/**
 * The applications of an opening side by side: criteria averages, overall average, recommendations, evaluations
 * received. A table on a desktop, one card per application on a phone (the shared `table.cards` rule). `personal` =
 * the unit head's view: the same figures through the `/me` route, without links to the candidate pages.
 */
@Component({
  selector: 'app-opening-comparison',
  imports: [TranslocoDirective, RouterLink, DecimalPipe, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './opening-comparison.html',
  styleUrl: './recruitment.css',
})
export class OpeningComparison {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly openingId = input.required<string>();
  readonly personal = input(false);

  protected readonly comparison = inject(RecruitmentApi).comparisonResource(this.openingId, this.personal);
  protected readonly notFound = computed(() => isNotFound(this.comparison.error()));
  protected readonly errorKey = computed(() => loadErrorKey(this.comparison.error(), 'recruitment.comparison.loadError'));

  protected readonly dir = signal<SortDir>('desc');
  protected readonly rows = computed<readonly ComparisonRow[]>(() => (this.comparison.hasValue() ? sortByAverage(this.comparison.value().rows, this.dir()) : []));
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly recommendations = RECOMMENDATIONS;
  protected readonly tone = stageTone;

  protected label(labels: Labels): string {
    return pickLabel(labels, this.lang());
  }

  protected averageOf(row: ComparisonRow, criterionId: string): number | null {
    return row.criteria.find((c) => c.criterionId === criterionId)?.average ?? null;
  }

  protected toggleSort(): void {
    this.dir.update((dir) => (dir === 'desc' ? 'asc' : 'desc'));
  }

  protected toggle(applicationId: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(applicationId)) next.add(applicationId);
      return next;
    });
  }

  reload(): void {
    this.comparison.reload();
  }
}
