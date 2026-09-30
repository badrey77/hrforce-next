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
 * Attendance (docs/contracts/attendance.md › Web):
 * - **A route without the chrome.** The entrance kiosk (`/kiosk`) is a full-screen display: no header, no nav, no
 *   skip link. Its route says so with STATIC route data, `data: { chrome: false }` (app.routes.ts), and this
 *   component reads it. The root component is not inside any route, so it cannot inject an `ActivatedRoute` of the
 *   page; instead it listens to the router: after each `NavigationEnd`, `chromeOf()` walks the activated route tree
 *   from the root to the deepest child (`firstChild`) and looks for `chrome: false` on the way. `toSignal()` turns
 *   that stream into a signal the template reads (`initialValue: true`: the normal layout until the first navigation
 *   ends). The alternative — a layout component with the chrome, and routes nested under it — would move every
 *   existing route one level down for the sake of one page.
 * - **Nav rules**: "Pointage" needs `attendance.punch_self` AND a linked employment (like My leave); "Mon équipe"
 *   appears when `GET /me/employment` says the user heads a unit today (`headOf`, no permission involved);
 *   "Présence" needs `attendance.read`, and a user who may only configure gets a link straight to the settings.
 *
 * Notifications (docs/contracts/notifications.md › Web): the header bell (shell/notification-bell.ts) is rendered only
 * while signed in. Its data — and the live SSE connection — belong to the root `NotificationCenter`, which opens and
 * closes the stream by itself as the Session changes; the shell only decides whether the bell is shown.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from './core/auth/session';
import { MyEmployment } from './core/leave/my-employment';
import { TasksBadge } from './core/tasks/tasks-badge';
import { LanguageSwitcher } from './shell/language-switcher';
import { NotificationBell } from './shell/notification-bell';
import { UserMenu } from './shell/user-menu';

/** Route `data` key: `chrome: false` hides the header, the nav and the skip link (the kiosk). */
export const CHROME_DATA_KEY = 'chrome';

/** False when the active route, or one of its parents, has `data: { chrome: false }`. */
export function chromeOf(root: ActivatedRouteSnapshot): boolean {
  for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
    if (route.data[CHROME_DATA_KEY] === false) return false;
  }
  return true;
}

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
  private readonly router = inject(Router);

  /** Header, nav and skip link are shown (every route except those with `data: { chrome: false }`). */
  protected readonly chrome = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => chromeOf(this.router.routerState.snapshot.root)),
    ),
    { initialValue: true },
  );

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
    {
      path: '/me/attendance',
      labelKey: 'nav.myAttendance',
      exact: false,
      permission: 'attendance.punch_self',
      visible: () => this.myEmployment.linked() === true,
    },
    { path: '/tasks', labelKey: 'nav.tasks', exact: false, badge: true },
    { path: '/me/team', labelKey: 'nav.myTeam', exact: false, visible: () => this.myEmployment.headsUnits() },
    { path: '/employees', labelKey: 'nav.employees', exact: false, permission: 'employee.read' },
    { path: '/leave', labelKey: 'nav.leave', exact: false, permission: 'leave.read' },
    { path: '/documents', labelKey: 'nav.documents', exact: false, permission: 'document.read' },
    { path: '/attendance', labelKey: 'nav.attendance', exact: false, permission: 'attendance.read' },
    {
      path: '/attendance/settings',
      labelKey: 'nav.attendanceSettings',
      exact: false,
      permission: 'attendance.configure',
      visible: () => !this.session.can('attendance.read'),
    },
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
