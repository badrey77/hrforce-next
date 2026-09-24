import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { LanguageSwitcher } from './shell/language-switcher';

interface NavLink {
  readonly path: string;
  readonly labelKey: string;
  readonly exact: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslocoDirective, LanguageSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly navLinks: readonly NavLink[] = [
    { path: '/', labelKey: 'nav.home', exact: true },
    { path: '/employees', labelKey: 'nav.employees', exact: false },
    { path: '/organization', labelKey: 'nav.organization', exact: false },
    { path: '/settings', labelKey: 'nav.settings', exact: false },
    { path: '/login', labelKey: 'nav.login', exact: false },
  ];
}
