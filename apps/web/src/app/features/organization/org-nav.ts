/**
 * `<app-org-nav>` — the two sections of the Organization feature as tabs-like links: Structure (/organization)
 * and Sites (/organization/sites).
 *
 * Why a sub-route for sites rather than a panel on the tree page: a site is a place, not a node of the tree, and
 * its list/search/create has nothing to share with the tree's as-of date or selection. A route of its own gives
 * it a linkable URL (`/organization/sites?q=oran`), keeps the tree page simple, and lets the router lazy-load the
 * sites code only when someone opens it (see organization.routes.ts).
 *
 * Angular concepts:
 * - **`routerLink`** navigates inside the app without reloading the page (the router intercepts the click).
 * - **`routerLinkActive="active"`** adds the CSS class while the link's URL is the current one;
 *   `[routerLinkActiveOptions]` with `paths: 'exact'` stops `/organization` from also matching `/organization/sites`;
 *   `queryParams: 'ignored'` keeps the link active on `/organization?asOf=…` (`{ exact: true }` would not).
 *   `ariaCurrentWhenActive="page"` sets `aria-current="page"` on the active link for screen readers.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { type IsActiveMatchOptions, RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

@Component({
  selector: 'app-org-nav',
  imports: [RouterLink, RouterLinkActive, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav *transloco="let t" class="org-nav" [attr.aria-label]="t('org.nav.label')">
      <a
        routerLink="/organization"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
        [routerLinkActiveOptions]="exactPath"
        >{{ t('org.nav.structure') }}</a
      >
      <a routerLink="/organization/sites" routerLinkActive="active" ariaCurrentWhenActive="page">{{
        t('org.nav.sites')
      }}</a>
    </nav>
  `,
  styles: `
    .org-nav {
      display: flex;
      gap: var(--space-2);
      margin-block-end: var(--space-4);
      border-block-end: 1px solid var(--color-border);
    }
    a {
      padding-block: var(--space-2);
      padding-inline: var(--space-3);
      color: inherit;
      text-decoration: none;
      border-block-end: 3px solid transparent;
    }
    a:hover { text-decoration: underline; }
    a.active { border-block-end-color: var(--color-primary); font-weight: 600; }
  `,
})
export class OrgNav {
  protected readonly exactPath: IsActiveMatchOptions = {
    paths: 'exact',
    queryParams: 'ignored',
    matrixParams: 'ignored',
    fragment: 'ignored',
  };
}
