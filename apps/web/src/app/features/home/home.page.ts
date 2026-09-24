import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

@Component({
  selector: 'app-home-page',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t('home.title') }}</h1>
      <p>{{ t('home.intro') }}</p>
    </ng-container>
  `,
})
// Template-only component; root oxlint lacks allowWithDecorator for this rule.
export class HomePage {}
