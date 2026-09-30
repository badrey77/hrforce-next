/**
 * `<app-control-error [control]="c.reason" errorId="void-reason-error" [keys]="{ required: 'attendance.reason.required' }" />`
 * — the error line under one field of the attendance forms: nothing while the control is valid or untouched; else a
 * translated server rule (`{ serverKey }`), the server's own text (`{ server }`), or the key mapped to the control's
 * first error name (`keys`), falling back to a generic "check this field".
 *
 * Angular concepts: the same technique as features/employees/field-error.ts (chapter 14) — `AbstractControl.events`
 * turned into a signal (`toObservable` → `switchMap` → `toSignal`), because an OnPush child is not re-checked when the
 * SAME control object becomes invalid; reading the control's events makes it react to exactly those changes. This
 * copy lives in shared/ (the employee one belongs to its feature) and takes its messages as an input, so each form
 * decides its own wording.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { AbstractControl } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { combineLatest, map, startWith, switchMap } from 'rxjs';

type ErrorView = { readonly key: string; readonly params: Record<string, unknown> } | { readonly text: string };

function viewOf(control: AbstractControl, keys: Readonly<Record<string, string>>): ErrorView | null {
  if (!control.invalid || !control.touched || !control.errors) return null;
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return { key: serverKey, params: {} };
  const server: unknown = control.getError('server');
  if (typeof server === 'string') return { text: server };
  const [name, detail] = Object.entries(control.errors)[0] ?? ['invalid', null];
  const params = typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
  return { key: keys[name] ?? 'attendance.settings.invalid', params };
}

@Component({
  selector: 'app-control-error',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as e) {
      <p *transloco="let t" class="field-error" [id]="errorId()">{{ 'text' in e ? e.text : t(e.key, e.params) }}</p>
    }
  `,
  styles: `
    :host { display: contents; }
  `,
})
export class ControlError {
  readonly control = input.required<AbstractControl>();
  readonly errorId = input.required<string>();
  /** Error name → translation key (e.g. `{ pattern: 'attendance.schedules.codeFormat' }`). */
  readonly keys = input<Readonly<Record<string, string>>>({});

  protected readonly error = toSignal(
    combineLatest([toObservable(this.control), toObservable(this.keys)]).pipe(
      switchMap(([control, keys]) =>
        control.events.pipe(
          startWith(null),
          map(() => viewOf(control, keys)),
        ),
      ),
    ),
    { initialValue: null },
  );
}
