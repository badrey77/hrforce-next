/**
 * `<app-org-unit-picker>` — a search-as-you-type combobox that picks ONE org unit. Its form value is the unit id
 * (`string | null`), so it plugs into reactive forms like a plain input:
 *
 *   <app-org-unit-picker formControlName="parentId" inputId="parent" [kinds]="['department', 'region']" [asOf]="date" />
 *
 * Lives in shared/: reusable UI with no feature knowledge. It may import core/ (OrgApi, models) but never features/.
 *
 * Angular concepts:
 * - **ControlValueAccessor (CVA)** is the bridge between the Forms API and a custom control. Forms call
 *   `writeValue()` when the model changes (setValue/patchValue/reset), `setDisabledState()` on disable/enable,
 *   and hand us two callbacks via `registerOnChange` / `registerOnTouched` that WE call when the user picks a
 *   unit or leaves the field. With that, `formControlName`, validators, `touched`, `disable()`… all just work.
 * - **`NG_VALUE_ACCESSOR` provider**: `formControlName` finds the CVA through DI. `useExisting` says "the
 *   accessor is this component instance"; `forwardRef()` is needed because the class is referenced inside its
 *   own decorator, before the class exists; `multi: true` because the token collects a list.
 * - **Signal inputs** — `input()` declares `[kinds]`, `[asOf]`… as read-only signals the parent sets.
 * - **Local state as `signal()`s**, and `computed()` for values derived from them (re-evaluated only when a
 *   signal it read changes). With zoneless change detection + OnPush, updating a signal read by the template
 *   is what schedules a re-render.
 * - **RxJS search pipeline**: every keystroke goes into a `Subject`; `debounceTime(250)` waits for a pause in
 *   typing; `switchMap` maps each query to an HTTP Observable and UNSUBSCRIBES from the previous one when a new
 *   query arrives — for HttpClient, unsubscribing aborts the request, so a slow stale response can never
 *   overwrite newer results. `takeUntilDestroyed()` ends the pipeline when the component is destroyed
 *   (it uses the component's `DestroyRef`, so it must be called in an injection context: here, the constructor).
 * - **Injecting an app-wide signal cache** (`KindCatalog`): the kind badge of each option is
 *   `kindCatalog.labelOf(unit.kind)`, which follows the active language (see core/org/kind-catalog.ts).
 * - **`host` metadata** binds events on the component's own element (`(focusout)`), no wrapper div needed.
 *
 * Accessibility: WAI-ARIA combobox pattern ("list autocomplete"): the text input has `role="combobox"`,
 * `aria-expanded`, `aria-controls` (the listbox) and `aria-activedescendant` (the highlighted option). Focus
 * stays in the input; ArrowDown/ArrowUp move the highlight, Enter selects, Escape closes (then clears), Home/End jump.
 */
import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { catchError, debounceTime, map, of, Subject, switchMap } from 'rxjs';
import { KindCatalog } from '../../core/org/kind-catalog';
import { OrgApi } from '../../core/org/org-api';
import type { OrgUnitKind, OrgUnitSummary } from '../../core/org/org.models';

/** How long typing must pause before a search is sent. */
export const ORG_UNIT_PICKER_DEBOUNCE_MS = 250;

let nextId = 0;

type SearchState = 'idle' | 'loading' | 'done' | 'error';

interface SearchRequest {
  readonly q: string;
  readonly kinds: readonly OrgUnitKind[] | undefined;
  readonly asOf: string | undefined;
}

export function orgUnitLabel(unit: Pick<OrgUnitSummary, 'code' | 'name'>): string {
  return `${unit.name} (${unit.code})`;
}

@Component({
  selector: 'app-org-unit-picker',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './org-unit-picker.html',
  styleUrl: './org-unit-picker.css',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => OrgUnitPicker), multi: true }],
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class OrgUnitPicker implements ControlValueAccessor {
  private readonly api = inject(OrgApi);
  protected readonly kindCatalog = inject(KindCatalog);

  /**
   * Only offer these kinds (e.g. `['department', 'region']`). Sent to the API as repeated params
   * (`kind=department&kind=region`); the server filters. Absent or empty → all kinds.
   */
  readonly kinds = input<readonly OrgUnitKind[]>();
  /** Search the tree as of this date (`YYYY-MM-DD`); server default is today. */
  readonly asOf = input<string>();
  /** id of the inner `<input>`, so an outside `<label for="…">` can name it. */
  readonly inputId = input(`org-unit-picker-${nextId++}`);
  /** Mirrors the form control's invalid+touched state onto `aria-invalid` (the CVA cannot see the control itself). */
  readonly invalid = input(false);
  /** id(s) of an outside error/hint element, forwarded to `aria-describedby`. */
  readonly describedBy = input<string | null>(null);

  protected readonly query = signal('');
  protected readonly selected = signal<OrgUnitSummary | null>(null);
  protected readonly results = signal<readonly OrgUnitSummary[]>([]);
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

  private readonly searches = new Subject<SearchRequest>();
  private readonly lookups = new Subject<string>();
  private onChange: (value: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  constructor() {
    this.searches
      .pipe(
        debounceTime(ORG_UNIT_PICKER_DEBOUNCE_MS),
        switchMap((request) => {
          this.state.set('loading');
          return this.api.search(request).pipe(
            map((result) => result.items),
            // Handle the error INSIDE switchMap: an error reaching the outer pipe would end it for good.
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

    // A value written by the form (e.g. a preset parent) is only an id: fetch the unit to show its label.
    this.lookups
      .pipe(
        switchMap((id) => this.api.get(id).pipe(catchError(() => of(null)))),
        takeUntilDestroyed(),
      )
      .subscribe((unit) => {
        if (unit) {
          this.selected.set(unit);
          this.query.set(orgUnitLabel(unit));
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
    if (this.selected()?.id !== value) {
      this.lookups.next(value);
    }
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
    // Typing over a chosen unit un-chooses it: the value is only ever a unit picked from the list.
    if (this.selected()) {
      this.selected.set(null);
      this.onChange(null);
    }
    this.startSearch();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
        if (!this.open()) {
          this.startSearch();
        } else if (count) {
          this.activeIndex.set((this.activeIndex() + 1) % count);
        }
        break;
      case 'ArrowUp':
        if (this.open() && count) {
          this.activeIndex.set((this.activeIndex() - 1 + count) % count);
        }
        break;
      case 'Home':
      case 'End':
        if (!this.open() || !count) return; // let the caret move inside the text
        this.activeIndex.set(event.key === 'Home' ? 0 : count - 1);
        break;
      case 'Enter': {
        const unit = this.results()[this.activeIndex()];
        if (!this.open() || !unit) return; // let Enter submit the surrounding form
        this.choose(unit);
        break;
      }
      case 'Escape':
        if (this.open()) {
          this.close();
        } else if (this.query() && !this.selected()) {
          this.query.set('');
        } else {
          return; // nothing to do: let a surrounding dialog handle Escape
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected choose(unit: OrgUnitSummary): void {
    this.selected.set(unit);
    this.query.set(orgUnitLabel(unit));
    this.close();
    this.onChange(unit.id);
  }

  /** Focus left the whole component (not just moved from the input to an option): close and report "touched". */
  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget;
    if (host instanceof Element && event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) {
      return;
    }
    this.close();
    this.onTouched();
  }

  private startSearch(): void {
    this.open.set(true);
    this.state.set('loading');
    this.searches.next({ q: this.query(), kinds: this.kinds(), asOf: this.asOf() });
  }

  private close(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
  }
}
