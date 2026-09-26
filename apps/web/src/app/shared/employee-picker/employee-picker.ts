/**
 * `<app-employee-picker>` — a search-as-you-type combobox that picks ONE employee (employment). Its form value is the
 * employment id (`string | null`), so it plugs into reactive forms like a plain input:
 *
 *   <app-employee-picker formControlName="employmentId" inputId="head-employee" [invalid]="…" describedBy="…" />
 *
 * Used for "Head of unit" (Organization) and "Linked employee" (Access). Searches `GET /api/employees?q=` (needs
 * `employee.read`; the API scopes the answer to the caller's units).
 *
 * This is the codebase's SECOND ControlValueAccessor; it deliberately copies the first one's structure
 * (shared/org-unit-picker/org-unit-picker.ts — read its header for the full explanation) so the two read alike:
 * - **The CVA contract in four methods.** `writeValue()` (form → control: display only, never call `onChange` from
 *   it), `registerOnChange()`/`registerOnTouched()` (we keep the callbacks and call them on USER action only),
 *   `setDisabledState()`.
 * - **`NG_VALUE_ACCESSOR` + `useExisting` + `forwardRef` + `multi: true`**: how `formControlName` finds this
 *   instance through DI.
 * - **RxJS search pipeline**: `Subject` → `debounceTime` → `switchMap` (cancels the stale request) →
 *   `catchError` INSIDE the `switchMap` (so one failed search does not end the pipeline) → `takeUntilDestroyed()`.
 * - **A preset value is only an id**: `writeValue('e-1')` fetches `GET /employees/e-1` to show the name.
 *
 * What differs, and why it is not a generic "entity picker": the option template (matricule, name, unit) and the
 * label function are the only differences; a shared abstract base class would save ~60 lines but make each picker
 * harder to read in isolation. If a third picker appears, extract the combobox mechanics (keyboard, ARIA, focus)
 * into a directive or a base class — the rule of three.
 *
 * Accessibility: the WAI-ARIA combobox "list autocomplete" pattern, identical to the org-unit picker.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  forwardRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { catchError, debounceTime, map, of, Subject, switchMap } from 'rxjs';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { EmployeeListItem } from '../../core/employees/employees.models';
import { LanguageService } from '../../core/i18n/language.service';
import type { AppLanguage } from '../../core/i18n/languages';
import { DisplayNamePipe, displayNameOf } from '../display-name/display-name.pipe';

/** How long typing must pause before a search is sent. */
export const EMPLOYEE_PICKER_DEBOUNCE_MS = 250;

let nextId = 0;

type SearchState = 'idle' | 'loading' | 'done' | 'error';

/** "NAME First (MATRICULE)" in `lang`. */
export function employeeLabel(employee: Pick<EmployeeListItem, 'matricule' | 'person'>, lang: AppLanguage = 'fr'): string {
  return `${displayNameOf(employee.person, lang)} (${employee.matricule})`;
}

@Component({
  selector: 'app-employee-picker',
  imports: [TranslocoDirective, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-picker.html',
  // Same look as the org-unit picker: one stylesheet for both comboboxes.
  styleUrl: '../org-unit-picker/org-unit-picker.css',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => EmployeePicker), multi: true }],
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class EmployeePicker implements ControlValueAccessor {
  private readonly api = inject(EmployeesApi);
  protected readonly lang = inject(LanguageService).current;

  /** id of the inner `<input>`, so an outside `<label for="…">` can name it. */
  readonly inputId = input(`employee-picker-${nextId++}`);
  /** Mirrors the form control's invalid+touched state onto `aria-invalid`. */
  readonly invalid = input(false);
  /** id(s) of an outside error/hint element, forwarded to `aria-describedby`. */
  readonly describedBy = input<string | null>(null);
  /** The whole list item of the employee the user picked (the form only gets the id). */
  readonly picked = output<EmployeeListItem | null>();

  protected readonly query = signal('');
  protected readonly selected = signal<EmployeeListItem | null>(null);
  protected readonly results = signal<readonly EmployeeListItem[]>([]);
  protected readonly state = signal<SearchState>('idle');
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  protected readonly disabled = signal(false);

  protected readonly listboxId = computed(() => `${this.inputId()}-listbox`);
  protected readonly statusId = computed(() => `${this.inputId()}-status`);
  protected readonly activeOptionId = computed(() =>
    this.open() && this.activeIndex() >= 0 ? this.optionId(this.activeIndex()) : null,
  );
  protected readonly ariaDescribedBy = computed(() =>
    [this.statusId(), this.describedBy()].filter((id): id is string => !!id).join(' '),
  );

  private readonly searches = new Subject<string>();
  private readonly lookups = new Subject<string>();
  private onChange: (value: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  constructor() {
    // The chosen employee's text follows the UI language (an <input>'s value is state, not a template expression).
    effect(() => {
      const lang = this.lang();
      const employee = untracked(this.selected);
      if (employee) this.query.set(employeeLabel(employee, lang));
    });

    this.searches
      .pipe(
        debounceTime(EMPLOYEE_PICKER_DEBOUNCE_MS),
        switchMap((q) => {
          this.state.set('loading');
          return this.api.search(q).pipe(
            map((page) => page.items),
            catchError(() => of(null)),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((items) => {
        this.state.set(items ? 'done' : 'error');
        this.results.set(items ?? []);
        this.activeIndex.set(items?.length ? 0 : -1);
      });

    this.lookups
      .pipe(
        switchMap((id) => this.api.get(id).pipe(catchError(() => of(null)))),
        takeUntilDestroyed(),
      )
      .subscribe((employee) => {
        if (employee) {
          this.selected.set(employee);
          this.query.set(employeeLabel(employee, this.lang()));
        }
      });
  }

  // --- ControlValueAccessor -------------------------------------------------------------------------------

  writeValue(value: string | null | undefined): void {
    if (!value) {
      this.selected.set(null);
      this.query.set('');
      return;
    }
    if (this.selected()?.id !== value) this.lookups.next(value);
  }

  registerOnChange(fn: (value: string | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    if (isDisabled) this.close();
  }

  // --- Template event handlers ----------------------------------------------------------------------------

  protected optionId(index: number): string {
    return `${this.inputId()}-option-${index}`;
  }

  protected onInput(event: Event): void {
    const text = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.query.set(text);
    if (this.selected()) {
      this.selected.set(null);
      this.onChange(null);
      this.picked.emit(null);
    }
    this.startSearch();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
        if (!this.open()) this.startSearch();
        else if (count) this.activeIndex.set((this.activeIndex() + 1) % count);
        break;
      case 'ArrowUp':
        if (this.open() && count) this.activeIndex.set((this.activeIndex() - 1 + count) % count);
        break;
      case 'Home':
      case 'End':
        if (!this.open() || !count) return;
        this.activeIndex.set(event.key === 'Home' ? 0 : count - 1);
        break;
      case 'Enter': {
        const employee = this.results()[this.activeIndex()];
        if (!this.open() || !employee) return;
        this.choose(employee);
        break;
      }
      case 'Escape':
        if (this.open()) this.close();
        else if (this.query() && !this.selected()) this.query.set('');
        else return;
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected choose(employee: EmployeeListItem): void {
    this.selected.set(employee);
    this.query.set(employeeLabel(employee, this.lang()));
    this.close();
    this.onChange(employee.id);
    this.picked.emit(employee);
  }

  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget;
    if (host instanceof Element && event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    this.close();
    this.onTouched();
  }

  private startSearch(): void {
    this.open.set(true);
    this.state.set('loading');
    this.searches.next(this.query());
  }

  private close(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
  }
}
