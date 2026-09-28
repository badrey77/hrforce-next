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
 *
 * Leave (docs/contracts/leave.md › Web):
 * - **A nav rule that is not just a permission.** "My leave" needs `leave.request_self` AND a linked employment. The
 *   link comes from `GET /api/me/employment` (root `MyEmployment` service), so the link data carries a `visible`
 *   predicate instead of a permission code; `visibleLinks` reads `myEmployment.linked()` inside the same `computed()`,
 *   and the link appears when that request answers 200. The link ALSO carries its own permission: the employment
 *   request is shared with "My documents" (`document.request_self`), so "linked" alone no longer implies either one.
 * - **A count badge** on "My tasks" from the root `TasksBadge` store (core/tasks/tasks-badge.ts: when and why it
 *   refreshes). The number inside the link is `aria-hidden` and the link gets a full accessible name ("My tasks, 3
 *   open"), so a screen reader never reads a bare "3". A separate `aria-live="polite"` region announces CHANGES of
 *   the count ("3 open tasks") without stealing focus; it is always in the DOM (a live region added together with its
 *   text is often not announced) and stays empty until the count is known.
 *
 * Notifications (docs/contracts/notifications.md › Web): the header bell (shell/notification-bell.ts) is rendered only
 * while signed in. Its data — and the live SSE connection — belong to the root `NotificationCenter`, which opens and
 * closes the stream by itself as the Session changes; the shell only decides whether the bell is shown.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from './core/auth/session';
import { MyEmployment } from './core/leave/my-employment';
import { TasksBadge } from './core/tasks/tasks-badge';
import { LanguageSwitcher } from './shell/language-switcher';
import { NotificationBell } from './shell/notification-bell';
import { UserMenu } from './shell/user-menu';

interface NavLink {
  readonly path: string;
  readonly labelKey: string;
  readonly exact: boolean;
  /** Shown only to users holding this permission (anywhere); absent = every signed-in user. */
  readonly permission?: string;
  /** A rule beyond one permission (reads signals: evaluated inside `visibleLinks`). */
  readonly visible?: () => boolean;
  /** Show the open-task count. */
  readonly badge?: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslocoDirective, LanguageSwitcher, NotificationBell, UserMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly session = inject(Session);
  private readonly myEmployment = inject(MyEmployment);
  protected readonly tasks = inject(TasksBadge);

  private readonly navLinks: readonly NavLink[] = [
    { path: '/', labelKey: 'nav.home', exact: true },
    { path: '/me/leave', labelKey: 'nav.myLeave', exact: false, permission: 'leave.request_self', visible: () => this.myEmployment.linked() === true },
    {
      path: '/me/documents',
      labelKey: 'nav.myDocuments',
      exact: false,
      permission: 'document.request_self',
      visible: () => this.myEmployment.linked() === true,
    },
    { path: '/tasks', labelKey: 'nav.tasks', exact: false, badge: true },
    { path: '/employees', labelKey: 'nav.employees', exact: false, permission: 'employee.read' },
    { path: '/leave', labelKey: 'nav.leave', exact: false, permission: 'leave.read' },
    { path: '/documents', labelKey: 'nav.documents', exact: false, permission: 'document.read' },
    { path: '/organization', labelKey: 'nav.organization', exact: false, permission: 'org_unit.read' },
    { path: '/access', labelKey: 'nav.access', exact: false, permission: 'access.read' },
    { path: '/settings', labelKey: 'nav.settings', exact: false },
  ];

  /** The links this user may see. `session.can()` reads the permissions signal, so this re-runs when they change. */
  protected readonly visibleLinks = computed(() =>
    this.navLinks.filter(
      (link) => (!link.permission || this.session.can(link.permission)) && (!link.visible || link.visible()),
    ),
  );
}
