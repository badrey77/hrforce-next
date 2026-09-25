/**
 * /organization/sites — list and search the company's sites, and create one. A site is a place (code, name, wilaya,
 * address) that hosts units; it is not a node of the tree (contract v2). Why a sub-route: see org-nav.ts.
 *
 * Angular concepts:
 * - **Query param → signal input → resource, again.** Like the tree page's `asOf`, the search text lives in the URL
 *   (`?q=oran`) and reaches the component as the signal input `q()` (router `withComponentInputBinding()`). The
 *   `sites` resource reads `q()`, so a new search — or the back button — re-fetches by itself. Searching is
 *   "navigate with a new `q`", nothing more.
 * - **Template reference variable** `#searchInput` names a DOM element inside the template, so the `(submit)`
 *   handler can read `searchInput.value` directly — no form library needed for a single search box. The form uses
 *   the native `(submit)` event: without `[formGroup]`/`ngModel` Angular's forms directives do not touch it, so the
 *   handler calls `preventDefault()` itself to stop the page reload.
 * - **Lazy-loaded route component**: organization.routes.ts uses `loadComponent` for this page, so its code is a
 *   separate chunk fetched the first time someone opens /organization/sites.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { OrgApi } from '../../core/org/org-api';
import type { Site } from '../../core/org/org.models';
import { CreateSiteForm } from './create-site-form';
import { OrgNav } from './org-nav';

@Component({
  selector: 'app-sites-page',
  imports: [TranslocoDirective, OrgNav, CreateSiteForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sites.page.html',
  styleUrl: './organization.page.css',
})
export class SitesPage {
  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** `?q=` bound by the router; absent → undefined (list all). */
  readonly q = input<string>();

  protected readonly sites = this.api.sitesResource(this.q);
  protected readonly items = computed<readonly Site[]>(() => (this.sites.hasValue() ? this.sites.value().items : []));
  protected readonly creating = signal(false);
  protected readonly created = signal<string | null>(null);

  protected readonly errorKey = computed(() => {
    const error = this.sites.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'org.sites.loadError';
  });

  protected search(event: Event, text: string): void {
    event.preventDefault();
    this.created.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: text.trim() || null },
      queryParamsHandling: 'merge',
    });
  }

  protected startCreate(): void {
    this.created.set(null);
    this.creating.set(true);
  }

  protected onCreated(site: Site): void {
    this.creating.set(false);
    this.created.set(site.name);
    this.sites.reload();
  }
}
