/**
 * /access/users — members of the company with their current and future grants as chips; search kept in the URL
 * (`?q=`). Same "query param → signal input → resource" loop as features/organization/sites.page.ts: searching is
 * just navigating with a new `q`.
 *
 * Angular concepts:
 * - **Data labels from a root catalogue**: chip texts use `AccessCatalog.roleName()` — the role name in the ACTIVE
 *   language, from the API — while fixed texts come from `t()`. A language switch re-renders both.
 * - **`@for` with `track`** on two levels (users, then each user's grants): `track user.id` / `track grant.id`
 *   lets Angular keep the DOM rows of unchanged items when the list is re-fetched, instead of rebuilding the table.
 * - **`[routerLink]` with an array** (`['/access/users', user.id]`): the router builds and encodes the URL from
 *   segments, so an id never needs manual escaping.
 *
 * Visibility is the server's call (contract: members with a grant inside the caller's `access.read` scope, or with
 * no grant at all so they can be granted); this page shows whatever `GET /access/users` returns.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import { AccessCatalog } from '../../core/access/access-catalog';
import type { AccessUser } from '../../core/access/access.models';
import { todayIso } from '../../core/date/iso-date';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { grantState } from './access-forms';
import { AccessNav } from './access-nav';

@Component({
  selector: 'app-access-users-page',
  imports: [TranslocoDirective, RouterLink, AccessNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.page.html',
  styleUrl: './access.css',
})
export class UsersPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly catalog = inject(AccessCatalog);

  /** `?q=` bound by the router; absent → list everyone visible. */
  readonly q = input<string>();

  protected readonly users = inject(AccessApi).usersResource(this.q);
  protected readonly items = computed<readonly AccessUser[]>(() => (this.users.hasValue() ? this.users.value().items : []));
  protected readonly today = todayIso();
  protected readonly grantState = grantState;

  protected readonly errorKey = computed(() => {
    const error = this.users.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'access.users.loadError';
  });

  protected search(event: Event, text: string): void {
    event.preventDefault();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: text.trim() || null },
      queryParamsHandling: 'merge',
    });
  }
}
