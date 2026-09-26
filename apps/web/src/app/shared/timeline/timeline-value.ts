/**
 * One value of a changed field: `<app-timeline-value [value]="line.after" />` — masked, empty, yes/no, a date range,
 * a timestamp (DatePipe, in the UI language) or text (already resolved to a name when the page knew it).
 *
 * Angular concepts:
 * - **A tiny presentational component instead of a repeated template fragment.** Each field line shows up to two
 *   values (before/after) with the same six cases. `<ng-template>` + `NgTemplateOutlet` could reuse the markup
 *   too, but its context is untyped (`let-v` is `any` under strictTemplates); a component with a typed
 *   `input.required<DisplayValue>()` keeps the `@switch` below type-checked.
 * - **`@switch` over a discriminated union.** `@case ('range')` narrows `v` to the range variant, so `v.from` type-checks.
 * - **`:host { display: contents }`**: the host element `<app-timeline-value>` does not create a box of its own,
 *   so the value flows inline in the sentence.
 * - `<bdi>` (plain HTML) isolates a value's text direction: a Latin code or id inside an Arabic sentence (or an
 *   Arabic name in the French UI) does not scramble the punctuation around it.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import type { DisplayValue } from './timeline-view';

@Component({
  selector: 'app-timeline-value',
  imports: [TranslocoDirective, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let v = value();
      @switch (v.kind) {
        @case ('masked') {
          <em class="masked" data-value="masked">{{ t('audit.masked') }}</em>
        }
        @case ('empty') {
          <em class="empty">{{ t('audit.emptyValue') }}</em>
        }
        @case ('bool') {
          {{ v.value ? t('audit.yes') : t('audit.no') }}
        }
        @case ('range') {
          {{ v.to ? t('audit.range', { from: v.from, to: v.to }) : t('audit.rangeOpen', { from: v.from }) }}
        }
        @case ('timestamp') {
          {{ v.iso | date: 'medium' : undefined : locale() }}
        }
        @case ('text') {
          <bdi>{{ v.text }}</bdi>
        }
      }
    </ng-container>
  `,
  styles: `
    :host { display: contents; }
    .masked, .empty { color: var(--color-text-muted); }
  `,
})
export class TimelineValue {
  private readonly language = inject(LanguageService);
  readonly value = input.required<DisplayValue>();
  protected readonly locale = computed(() => dateLocaleOf(this.language.current()));
}
