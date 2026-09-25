/**
 * The application shell: header (title, user menu, language switcher), side nav, `<main>` with the router outlet.
 *
 * Angular concepts: the nav is shown only when `session.isAuthenticated()` (a `computed()` of the root Session
 * store) is true. Because the template reads that signal, signing in or out re-renders the shell on its own.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from './core/auth/session';
import { LanguageSwitcher } from './shell/language-switcher';
import { UserMenu } from './shell/user-menu';

interface NavLink {
  readonly path: string;
  readonly labelKey: string;
  readonly exact: boolean;
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

  protected readonly navLinks: readonly NavLink[] = [
    { path: '/', labelKey: 'nav.home', exact: true },
    { path: '/employees', labelKey: 'nav.employees', exact: false },
    { path: '/organization', labelKey: 'nav.organization', exact: false },
    { path: '/settings', labelKey: 'nav.settings', exact: false },
  ];
}
