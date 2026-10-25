import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { AbstractControl } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, startWith, switchMap } from 'rxjs';
import { profileErrorKey, profileErrorParams } from './profile-forms';

interface ErrorView {
  readonly server: string | null;
  readonly key: string;
  readonly params: Record<string, string | number>;
}

function viewOf(control: AbstractControl): ErrorView | null {
  if (!control.invalid || !control.touched) return null;
  const server: unknown = control.getError('server');
  return { server: typeof server === 'string' ? server : null, key: profileErrorKey(control), params: profileErrorParams(control) };
}

/** The error line under a profile form field (shown once touched), referenced by the input's `aria-describedby`. */
@Component({
  selector: 'app-profile-field-error',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as e) {
      <p *transloco="let t" class="field-error" [id]="errorId()">{{ e.server ?? t(e.key, e.params) }}</p>
    }
  `,
  styles: `
    :host { display: contents; }
  `,
})
export class ProfileFieldError {
  readonly control = input.required<AbstractControl>();
  readonly errorId = input.required<string>();

  protected readonly error = toSignal(
    toObservable(this.control).pipe(
      switchMap((control) =>
        control.events.pipe(
          startWith(null),
          map(() => viewOf(control)),
        ),
      ),
    ),
    { initialValue: null },
  );
}
