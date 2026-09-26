/**
 * `<app-field-error [control]="c" errorId="x-error" />` — the error line under one form field: nothing while the
 * control is valid or untouched, else the server's text (`{ server }`) or the translated message of its first error
 * (`fieldErrorKey`/`fieldErrorParams`, employee-forms.ts). The Employees forms have ~25 fields; this keeps each field
 * to one line of template instead of five.
 *
 * Angular concepts:
 * - **Why a child component needs `control.events`.** With OnPush + zoneless change detection, a child is only
 *   re-checked when one of its inputs changes or a signal it reads changes. The `control` input is the SAME object
 *   before and after the user blurs the field or the server rejects it, so a template reading
 *   `control().errors` directly would stay stale. `AbstractControl.events` is an Observable of everything that
 *   happens to a control (value, status, touched, pristine, submitted); turning it into a signal makes the child
 *   react to exactly those changes.
 * - **`toObservable()` + `switchMap` + `toSignal()`** (`@angular/core/rxjs-interop`): `toObservable(this.control)`
 *   emits the current control (and a new one if the input is re-bound), `switchMap` follows that control's
 *   `events` (dropping the previous control's), `startWith(null)` computes the first state immediately, and
 *   `toSignal` exposes the result to the template and unsubscribes when the component is destroyed.
 * - The page still binds `aria-invalid`/`aria-describedby` on the input itself (its own template re-renders on the
 *   input's DOM events); this component only owns the text, under a stable id the input can point to.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { AbstractControl } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, startWith, switchMap } from 'rxjs';
import { fieldErrorKey, fieldErrorParams } from './employee-forms';

interface ErrorView {
  readonly server: string | null;
  readonly key: string;
  readonly params: Record<string, string | number>;
}

function viewOf(control: AbstractControl): ErrorView | null {
  if (!control.invalid || !control.touched) return null;
  const server: unknown = control.getError('server');
  return {
    server: typeof server === 'string' ? server : null,
    key: fieldErrorKey(control),
    params: fieldErrorParams(control),
  };
}

@Component({
  selector: 'app-field-error',
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
export class FieldError {
  readonly control = input.required<AbstractControl>();
  /** id of the error line, referenced by the input's `aria-describedby`. */
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
