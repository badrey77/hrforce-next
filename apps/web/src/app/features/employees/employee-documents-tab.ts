/**
 * The employee page's **Documents** tab (`document.read`): the register rows of this employee (every document ever
 * issued for this employment, void ones muted) and "Issue a document" with the employee preselected
 * (docs/contracts/documents.md › Web › Employee detail). `<app-employee-documents-tab [employee]="e" />`.
 *
 * Angular concepts:
 * - **Reusing a feature's building blocks without importing the feature.** The rows are the shared
 *   `<app-document-table>` (shared/documents/) and the data comes from the root `DocumentsApi` (core/documents/) —
 *   the same pieces as the /documents register. A feature never imports another feature (chapter 10), so the
 *   Employees feature links to the Documents feature by URL only: `/documents/new?employee=<id>`.
 * - **`[routerLink]` + `[queryParams]`**: `<a [routerLink]="'/documents/new'" [queryParams]="{ employee: id }">` builds
 *   `/documents/new?employee=…` and encodes the value; the issue page reads it as an input.
 * - **A resource keyed on an input, created only when the tab is shown** (the Leave tab's pattern): `@switch` renders
 *   one panel at a time, so this component — and its request — exist only while the tab is open.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { DocumentsApi } from '../../core/documents/documents-api';
import { DEFAULT_DOCUMENT_QUERY, type IssuedDocumentView } from '../../core/documents/documents.models';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DocumentTable } from '../../shared/documents/document-table';

@Component({
  selector: 'app-employee-documents-tab',
  imports: [TranslocoDirective, RouterLink, CanDirective, DocumentTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <div class="toolbar">
        <h2>{{ t('documents.employee.title') }}</h2>
        <a *appCan="'document.issue'" class="btn" routerLink="/documents/new" [queryParams]="{ employee: employee().id }" data-action="issue-document">
          {{ t('documents.issue.action') }}
        </a>
      </div>
      <section [attr.aria-busy]="list.isLoading()">
        @if (list.error()) {
          <div class="form-error" role="alert">
            <p>{{ t('documents.list.loadError') }}</p>
            <button class="btn secondary" type="button" (click)="list.reload()">{{ t('common.retry') }}</button>
          </div>
        } @else if (list.hasValue()) {
          <app-document-table [items]="items()" [showEmployee]="false" [empty]="t('documents.employee.empty')" />
          @if (total() > items().length) {
            <p class="muted">
              <a routerLink="/documents" [queryParams]="{ q: employee().matricule }">{{ t('documents.employee.more', { count: total() }) }}</a>
            </p>
          }
        } @else {
          <p class="muted">{{ t('common.loading') }}</p>
        }
      </section>
    </ng-container>
  `,
})
export class EmployeeDocumentsTab {
  readonly employee = input.required<EmployeeDetail>();

  protected readonly list = inject(DocumentsApi).listResource(() => ({
    ...DEFAULT_DOCUMENT_QUERY,
    employmentId: this.employee().id,
    pageSize: 100,
  }));
  protected readonly items = computed<readonly IssuedDocumentView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
}
