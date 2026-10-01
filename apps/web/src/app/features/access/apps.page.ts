/**
 * /access/apps — the company's connected apps (docs/contracts/sso.md › Web): name (+ Arabic name), client id, status,
 * roles count, users count and when the current secret was issued. « Nouvelle application » for `sso.manage_apps`.
 *
 * Angular concepts:
 * - **A resource gated by a permission signal**: `clientsResource(this.canRead)` sends `GET /sso/clients` only while
 *   `canRead()` is true (the route already requires `sso.read`; the gate keeps the service safe to reuse).
 * - **A relative time with an explicit `now`** (`relativeTime` pure pipe, chapter 16): "il y a 3 jours" for
 *   `credentialSetAt`, with the exact date in `title` and in `<time datetime>`.
 * - **`*appCan` with an `else` template** (chapter 12) for the create button or the read-only note. Hiding it is
 *   comfort: a REGIONAL `sso.manage_apps` holder still sees the button, and the API answers 403 `forbidden-scope`
 *   (writes need the permission over the whole company), which the form explains.
 * - Identifiers are Latin: `dir="ltr"` on the client id keeps `sso-demo` from being mirrored in the Arabic table.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import type { SsoClientView } from '../../core/sso/sso.models';
import { CanDirective } from '../../shared/can/can.directive';
import { RelativeTimePipe } from '../../shared/relative-time/relative-time.pipe';
import { AccessNav } from './access-nav';

@Component({
  selector: 'app-access-apps-page',
  imports: [TranslocoDirective, RouterLink, AccessNav, CanDirective, RelativeTimePipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './access.css',
  template: `
    <ng-container *transloco="let t">
      <app-access-nav />
      <div class="toolbar">
        <h2>{{ t('sso.apps.title') }}</h2>
        <a *appCan="'sso.manage_apps'; else readOnlyNote" class="btn" routerLink="/access/apps/new" data-action="new-app">
          {{ t('sso.apps.create') }}
        </a>
        <ng-template #readOnlyNote>
          <p class="muted" data-note="read-only">{{ t('sso.apps.readOnlyNote') }}</p>
        </ng-template>
      </div>
      <p class="field-hint">{{ t('sso.apps.intro') }}</p>

      <section [attr.aria-busy]="clients.isLoading()">
        @if (clients.error()) {
          <div class="form-error" role="alert">
            <p>{{ t(errorKey()) }}</p>
            <button class="btn secondary" type="button" (click)="clients.reload()">{{ t('common.retry') }}</button>
          </div>
        } @else if (clients.hasValue()) {
          <div class="table-scroll">
            <table class="data" data-table="apps">
              <thead>
                <tr>
                  <th scope="col">{{ t('sso.apps.name') }}</th>
                  <th scope="col">{{ t('sso.apps.clientId') }}</th>
                  <th scope="col">{{ t('sso.apps.status') }}</th>
                  <th scope="col">{{ t('sso.apps.roles') }}</th>
                  <th scope="col">{{ t('sso.apps.users') }}</th>
                  <th scope="col">{{ t('sso.apps.credentialSetAt') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (app of items(); track app.id) {
                  <tr [attr.data-app]="app.clientId" [class.ended]="app.status === 'disabled'">
                    <td>
                      <a [routerLink]="['/access/apps', app.id]">{{ app.name }}</a>
                      @if (app.nameAr) {
                        <br /><span class="muted" lang="ar" dir="rtl">{{ app.nameAr }}</span>
                      }
                    </td>
                    <td><span class="code" dir="ltr">{{ app.clientId }}</span></td>
                    <td><span class="badge" [attr.data-app-status]="app.status">{{ t('sso.status.' + app.status) }}</span></td>
                    <td>{{ app.roles.length }}</td>
                    <td>{{ app.assignmentCount }}</td>
                    <td class="nowrap">
                      <time [attr.datetime]="app.credentialSetAt" [attr.title]="app.credentialSetAt | date: 'medium' : undefined : locale()">{{
                        app.credentialSetAt | relativeTime: lang() : now
                      }}</time>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="6">{{ t('sso.apps.empty') }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="muted">{{ t('common.loading') }}</p>
        }
      </section>
    </ng-container>
  `,
})
export class AppsPage {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  /** Read once: the list is a snapshot, re-rendered when it is re-fetched. */
  protected readonly now = Date.now();

  private readonly canRead = inject(Session).allows('sso.read');
  protected readonly clients = inject(SsoApi).clientsResource(this.canRead);
  protected readonly items = computed<readonly SsoClientView[]>(() => (this.clients.hasValue() ? this.clients.value().items : []));

  protected readonly errorKey = computed(() => {
    const error = this.clients.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'sso.apps.loadError';
  });
}
