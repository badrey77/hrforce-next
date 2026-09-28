/**
 * `<app-notification-text [notification]="n" [now]="now()" />` — one notification as a sentence in the UI language,
 * plus when it happened ("il y a 5 minutes", full date as a tooltip). Used by the header bell and the /notifications
 * page, inside their own link/row markup.
 *
 * Angular concepts:
 * - **A presentational component with signal inputs.** It receives data (`input.required()`), injects only formatting
 *   services (language, leave catalogue) and emits nothing: the host decides what a click does. Both hosts render it
 *   inside an `<a>`, so it must contain phrasing content only (`display: contents` on the host, `<span>`s inside).
 * - **`computed()` per instance** builds the key + placeholders from the pure `notificationMessage()`; it re-runs when
 *   the notification, the language or the leave catalogue changes (a language switch re-words every item).
 * - **Missing-key fallback in the template**: Transloco returns the key itself for an unknown key, so
 *   `sentence === key` means "no sentence for this type yet" → the generic one.
 * - `DatePipe` for the tooltip, our `relativeTime` pipe for the visible text (its header explains the `now` argument).
 */
import { DatePipe, formatDate, formatNumber } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { NotificationView } from '../../core/notifications/notifications.models';
import { RelativeTimePipe } from '../relative-time/relative-time.pipe';
import { notificationMessage } from './notification-message';

@Component({
  selector: 'app-notification-text',
  imports: [TranslocoDirective, DatePipe, RelativeTimePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let m = message();
      @let sentence = t(m.key, m.documentTypeKey ? withDocumentType(m.params, m.documentTypeKey, t(m.documentTypeKey)) : m.params);
      <span class="sentence" data-sentence>{{ sentence === m.key ? t('notifications.types.unknown') : sentence }}</span>
      <time class="when" [attr.datetime]="notification().createdAt" [title]="notification().createdAt | date: 'medium' : undefined : locale()">{{
        notification().createdAt | relativeTime: lang() : now()
      }}</time>
    </ng-container>
  `,
  styles: `
    :host { display: contents; }
    .sentence { display: block; }
    .when { display: block; font-size: 0.8125rem; color: var(--color-text-muted); }
  `,
})
export class NotificationText {
  private readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly notification = input.required<NotificationView>();
  /** "Now" for the relative time (see relative-time.pipe.ts). */
  readonly now = input<number>(Date.now());

  /**
   * Adds the translated document type name to the placeholders (a pipe-free two-step translation: the template
   * translates the type's key first, then the sentence). An unknown code (Transloco returns the key) shows the code.
   */
  protected withDocumentType(params: Readonly<Record<string, string>>, key: string, name: string): Record<string, string> {
    return { ...params, documentType: name === key ? key.slice(key.lastIndexOf('.') + 1) : name };
  }

  protected readonly message = computed(() => {
    const locale = this.locale();
    return notificationMessage(this.notification(), {
      leaveType: (code) => this.catalog.nameOfCode(code),
      date: (iso) => formatDate(iso, 'mediumDate', locale),
      days: (days) => formatNumber(days, locale, '1.0-1'),
      arabic: this.lang() === 'ar',
    });
  });
}
