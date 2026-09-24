import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { LanguageService } from '../core/i18n/language.service';
import { isAppLanguage } from '../core/i18n/languages';

@Component({
  selector: 'app-language-switcher',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <label class="switcher">
        <span>{{ t('language.label') }}</span>
        <select [value]="language.current()" (change)="onChange($event)">
          @for (lang of language.available; track lang) {
            <option [value]="lang" [attr.lang]="lang" [selected]="lang === language.current()">
              {{ t('language.' + lang) }}
            </option>
          }
        </select>
      </label>
    </ng-container>
  `,
  styles: `
    .switcher {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }
    select {
      padding-block: var(--space-1);
      padding-inline: var(--space-2);
      border-radius: var(--radius);
      border: 1px solid var(--color-border);
    }
  `,
})
export class LanguageSwitcher {
  protected readonly language = inject(LanguageService);

  protected onChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLSelectElement && isAppLanguage(target.value)) {
      this.language.use(target.value);
    }
  }
}
