/**
 * The application shell: header (title, user menu, language switcher), side nav, `<main>` with the router outlet.
 *
 * Angular concepts: the nav is shown only when `session.isAuthenticated()` (a `computed()` of the root Session
 * store) is true. Because the template reads that signal, signing in or out re-renders the shell on its own.
 *
 * Permission-aware nav (docs/contracts/authorization.md › Web): Employees needs `employee.read`, Organization needs
 * `org_unit.read`, Access needs `access.read`. The links are filtered in a `computed()` rather than with `*appCan` on each `<li>`: the rule lives
 * next to the link data (a `permission` field), the template stays one plain `@for`, and the list is rebuilt only
 * when the session's `permissions` change. (`*appCan` — shared/can/can.directive.ts — is the better fit for a
 * one-off element, e.g. the Sites tab in features/organization/org-nav.ts.) Hiding a link is comfort, not
 * security: the route also has `permissionGuard`, and the API checks every call.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from './core/auth/session';
import { LanguageSwitcher } from './shell/language-switcher';
import { UserMenu } from './shell/user-menu';

interface NavLink {
  readonly path: string;
  readonly labelKey: string;
  readonly exact: boolean;
  /** Shown only to users holding this permission (anywhere); absent = every signed-in user. */
  readonly permission?: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslocoDirective, LanguageSwitcher, UserMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly session = inject(Session);

  private readonly navLinks: readonly NavLink[] = [
    { path: '/', labelKey: 'nav.home', exact: true },
    { path: '/employees', labelKey: 'nav.employees', exact: false, permission: 'employee.read' },
    { path: '/organization', labelKey: 'nav.organization', exact: false, permission: 'org_unit.read' },
    { path: '/access', labelKey: 'nav.access', exact: false, permission: 'access.read' },
    { path: '/settings', labelKey: 'nav.settings', exact: false },
  ];

  /** The links this user may see. `session.can()` reads the permissions signal, so this re-runs when they change. */
  protected readonly visibleLinks = computed(() =>
    this.navLinks.filter((link) => !link.permission || this.session.can(link.permission)),
  );
}
