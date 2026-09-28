/**
 * `<app-document-table [items]="rows" />` — rows of the documents register: number (link to the detail), type,
 * employee, language, issue date, status. Voided rows are muted; a titre de congé whose leave was cancelled afterwards
 * gets a "leave cancelled" badge (contract assumption 9: HR decides whether to void it).
 *
 * Used by the register (/documents), the employee Documents tab and the leave request page — three features, so it
 * lives in shared/ (a feature never imports another feature).
 *
 * Angular concepts:
 * - **A presentational component**: signal inputs in, markup out; no request, no output. Each host owns its resource,
 *   its loading and error states, and passes the rows. `[showEmployee]="false"` drops the column where the employee is
 *   already the page's subject.
 * - **`[class.muted]="…"`** — a class binding toggles ONE class from a boolean, leaving the element's other classes
 *   alone (`[class]="…"` would replace them all).
 * - **A status badge reusing the global colours**: `[attr.data-status]` maps `issued`/`void` onto the existing
 *   `approved`/`cancelled` badge styles (src/styles.css) instead of adding new ones; the TEXT says "Émis"/"Annulé".
 * - `dir="auto"` on the name: an Arabic name in a French row (or the reverse) is laid out in its own direction.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { IssuedDocumentView } from '../../core/documents/documents.models';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { DisplayNamePipe } from '../display-name/display-name.pipe';

@Component({
  selector: 'app-document-table',
  imports: [TranslocoDirective, RouterLink, DatePipe, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <div class="table-scroll">
        <table class="data" data-table="documents">
          <thead>
            <tr>
              <th scope="col">{{ t('documents.fields.number') }}</th>
              <th scope="col">{{ t('documents.fields.type') }}</th>
              @if (showEmployee()) {
                <th scope="col">{{ t('documents.fields.employee') }}</th>
              }
              <th scope="col">{{ t('documents.fields.language') }}</th>
              <th scope="col">{{ t('documents.fields.issueDate') }}</th>
              <th scope="col">{{ t('documents.fields.status') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (d of items(); track d.id) {
              <tr [attr.data-document]="d.id" [class.muted]="d.status === 'void'">
                <td class="nowrap">
                  <a class="code" [routerLink]="['/documents', d.id]">{{ d.number }}</a>
                </td>
                <td>{{ label(d.type.labels) }}</td>
                @if (showEmployee()) {
                  <td>
                    <span dir="auto">{{ d.employee.person | displayName: lang() }}</span>
                    <span class="code muted"> {{ d.employee.matricule }}</span>
                  </td>
                }
                <td>{{ t('documents.languages.' + d.language) }}</td>
                <td class="nowrap">{{ d.issueDate | date: 'mediumDate' : undefined : locale() }}</td>
                <td>
                  <span class="badge" [attr.data-status]="d.status === 'void' ? 'cancelled' : 'approved'" data-field="status">
                    {{ t('documents.status.' + d.status) }}
                  </span>
                  @if (d.warnings.includes('leave-cancelled')) {
                    &ngsp;<span class="badge" data-status="pending" data-warning="leave-cancelled">{{ t('documents.warnings.leave-cancelled') }}</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td [attr.colspan]="showEmployee() ? 6 : 5" class="muted" data-state="empty">{{ empty() || t('documents.list.empty') }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </ng-container>
  `,
})
export class DocumentTable {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly items = input.required<readonly IssuedDocumentView[]>();
  readonly showEmployee = input(true);
  /** Text of the empty row (already translated); default "No document". */
  readonly empty = input('');

  protected label(labels: IssuedDocumentView['type']['labels']): string {
    return pickLabel(labels, this.lang());
  }
}
