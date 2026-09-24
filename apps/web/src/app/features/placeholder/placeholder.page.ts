import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

/** Temporary page for navigation targets whose feature has not been built yet. */
@Component({
  selector: 'app-placeholder-page',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t(titleKey()) }}</h1>
      <p>{{ t('placeholder.comingSoon') }}</p>
    </ng-container>
  `,
})
export class PlaceholderPage {
  /** Bound from route `data.titleKey` (withComponentInputBinding). */
  readonly titleKey = input('app.title');
}
