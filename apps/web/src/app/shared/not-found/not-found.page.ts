import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

@Component({
  selector: 'app-not-found-page',
  imports: [TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>404</h1>
      <p>{{ t('errors.notFound') }}</p>
      <a routerLink="/">{{ t('common.backHome') }}</a>
    </ng-container>
  `,
})
// Template-only component; root oxlint lacks allowWithDecorator for this rule.
export class NotFoundPage {}
