import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The icons of the side menu, drawn as inline SVG strokes in the link's own colour (`currentColor`).
 * No icon font and no external file: the CSP allows neither, and an inline `<svg>` needs no request.
 * Purely decorative (`aria-hidden`): the link's text is its name.
 */
const ICONS = {
  home: ['M3 11.5 12 4l9 7.5', 'M5.5 10v9.5h13V10', 'M10 19.5v-5.5h4v5.5'],
  calendar: ['M4 6.5h16v13H4z', 'M4 10.5h16', 'M8 4v4', 'M16 4v4'],
  'calendar-check': ['M4 6.5h16v13H4z', 'M4 10.5h16', 'M8 4v4', 'M16 4v4', 'm9 15 2 2 4-4'],
  file: ['M7 3.5h7l4 4v13H7z', 'M14 3.5v4h4', 'M10 12.5h5', 'M10 16h5'],
  files: ['M9 3.5h6l4 4v10H9z', 'M15 3.5v4h4', 'M9 7H5.5v13.5H15V17.5'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  'clock-check': ['M12 3.5a8.5 8.5 0 1 0 8.5 8.5', 'M12 7.5V12l3 2', 'm15.5 5.5 2 2 3.5-3.5'],
  tasks: ['M4 5h4v4H4z', 'M4 15h4v4H4z', 'M11 7h9', 'M11 17h9', 'M11 12h9'],
  team: ['M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3.5 19.5c.4-3.2 2.6-5 5.5-5s5.1 1.8 5.5 5', 'M16 11a2.5 2.5 0 1 0-1-4.8', 'M17 14.6c2 .5 3.2 2.1 3.5 4.9'],
  briefcase: ['M3.5 8h17v11h-17z', 'M9 8V5.5h6V8', 'M3.5 13h17', 'M11 13v1.5h2V13'],
  interview: ['M4 5h16v10.5h-8.5L7 19.5v-4H4z', 'M8 9h8', 'M8 12h5'],
  employees: ['M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M5 20c.5-3.8 3.2-6 7-6s6.5 2.2 7 6'],
  'user-plus': ['M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3.5 20c.5-3.8 3-6 6.5-6 1.6 0 3 .5 4.1 1.3', 'M18 14v6', 'M15 17h6'],
  sliders: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4', 'M4 12h14', 'M20 12h0'],
  organization: ['M9.5 3.5h5v4h-5z', 'M3.5 16.5h5v4h-5z', 'M15.5 16.5h5v4h-5z', 'M12 7.5v4.5', 'M6 16.5V12h12v4.5'],
  access: ['M8 14a4.5 4.5 0 1 1 4.2-6H20v3h-2v2.5h-3V11h-2.8A4.5 4.5 0 0 1 8 14z', 'M7.5 9.5h0'],
  settings: [
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    'M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6',
  ],
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
} as const;

export type NavIconName = keyof typeof ICONS;

@Component({
  selector: 'app-nav-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      @for (d of paths(); track d) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host { display: inline-flex; flex-shrink: 0; }
  `,
})
export class NavIcon {
  readonly name = input.required<NavIconName>();
  protected readonly paths = computed(() => ICONS[this.name()]);
}
