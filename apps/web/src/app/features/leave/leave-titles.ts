/**
 * `<app-leave-titles [request]="r" />` — the "Titre de congé" block of the HR leave request page
 * (docs/contracts/documents.md › Web › Leave request detail): the titres already issued for this request (register rows,
 * `GET /documents?leaveRequestId=`), and, once the request is APPROVED, a "Titre de congé" link to the issue page with
 * the type, the employee and the request preselected.
 *
 * Angular concepts:
 * - **Two different permission checks in one block.** The list needs `document.read`, the link `document.issue`; the
 *   host renders this component only when the session holds `document.read` (`@if (canTitles())`), and the link uses
 *   `*appCan="'document.issue'"`. Both are "held anywhere"; the API scopes the answers (the register only lists
 *   documents in the caller's scope, the issue page's POST answers 404 out of scope).
 * - **A link carrying several query params**: `[queryParams]="{ type: 'titre_conge', leaveRequest: r.id, employee: … }"`
 *   — the Documents feature is reached by URL only (features never import each other).
 * - **A resource keyed on an input** (the request id), so a request page reused for another id re-asks by itself.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { DocumentsApi } from '../../core/documents/documents-api';
import { DEFAULT_DOCUMENT_QUERY, type IssuedDocumentView } from '../../core/documents/documents.models';
import type { LeaveRequestDetail } from '../../core/leave/leave.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DocumentTable } from '../../shared/documents/document-table';

@Component({
  selector: 'app-leave-titles',
  imports: [TranslocoDirective, RouterLink, CanDirective, DocumentTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <div class="toolbar">
        <h2 id="leave-titles-title">{{ t('documents.leave.title') }}</h2>
        @if (request().status === 'approved') {
          <a *appCan="'document.issue'" class="btn" routerLink="/documents/new" data-action="titre-conge"
            [queryParams]="{ type: 'titre_conge', leaveRequest: request().id, employee: request().employee.id }">
            {{ t('documents.leave.issue') }}
          </a>
        }
      </div>
      <div [attr.aria-busy]="titles.isLoading()">
        @if (titles.error()) {
          <div class="form-error" role="alert">
            <p>{{ t('documents.list.loadError') }}</p>
            <button class="btn secondary" type="button" (click)="titles.reload()">{{ t('common.retry') }}</button>
          </div>
        } @else if (titles.hasValue()) {
          <app-document-table [items]="items()" [showEmployee]="false" [empty]="t('documents.leave.none')" />
        } @else {
          <p class="muted">{{ t('common.loading') }}</p>
        }
      </div>
    </ng-container>
  `,
})
export class LeaveTitles {
  readonly request = input.required<LeaveRequestDetail>();

  protected readonly titles = inject(DocumentsApi).listResource(() => ({
    ...DEFAULT_DOCUMENT_QUERY,
    leaveRequestId: this.request().id,
    pageSize: 100,
  }));
  protected readonly items = computed<readonly IssuedDocumentView[]>(() => (this.titles.hasValue() ? this.titles.value().items : []));
}
