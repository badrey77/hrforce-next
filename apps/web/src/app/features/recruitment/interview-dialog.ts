import { ChangeDetectionStrategy, Component, type ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { catchError, debounceTime, map, type Observable, of, Subject, switchMap } from 'rxjs';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  CANCEL_REASON_MAX,
  CANCEL_REASON_MIN,
  DURATION_DEFAULT,
  DURATION_MAX,
  DURATION_MIN,
  INTERVIEW_MODES,
  type InterviewerOption,
  INTERVIEWERS_MAX,
  type InterviewInput,
  type InterviewMode,
  type InterviewView,
  LABEL_MAX,
  LOCATION_MAX,
  type UserRef,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, isoDate, recruitmentProblemToForm, text, wholeNumber, withoutFieldIndex } from './recruitment-forms';
import { actionErrorKey, isStale } from './recruitment-view';
import type { MoveFailure } from './stage-move';

/** How long typing must pause before the interviewer search is sent. */
export const INTERVIEWER_SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN = 2;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface InterviewSubject {
  readonly applicationId: string;
  readonly name: string;
}

export interface InterviewOutcome {
  readonly interview: InterviewView;
  readonly kind: 'scheduled' | 'updated' | 'cancelled';
  readonly name: string;
}

type Pending =
  | { readonly kind: 'schedule'; readonly subject: InterviewSubject }
  | { readonly kind: 'edit'; readonly interview: InterviewView; readonly name: string }
  | { readonly kind: 'cancel'; readonly interview: InterviewView; readonly name: string };

function oneToFive(control: AbstractControl): ValidationErrors | null {
  const count = Array.isArray(control.value) ? control.value.length : 0;
  if (count === 0) return { required: true };
  return count > INTERVIEWERS_MAX ? { interviewersMax: { max: INTERVIEWERS_MAX } } : null;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

/** Schedules, changes or cancels one interview (the candidate page and the board share it). */
@Component({
  selector: 'app-interview-dialog',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './interview-dialog.html',
  styles: `
    .chosen, .results { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0 0 var(--space-2); padding: 0; list-style: none; }
    .results { display: grid; }
    .chosen li { display: inline-flex; align-items: center; gap: var(--space-1); padding-inline-start: var(--space-3); border: 1px solid var(--color-border); border-radius: 999px; }
    .chosen button { min-inline-size: 2.75rem; min-block-size: 2.75rem; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
    .results button { inline-size: 100%; padding-block: var(--space-2); padding-inline: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); color: inherit; font: inherit; text-align: start; cursor: pointer; }
  `,
})
export class InterviewDialog {
  private readonly api = inject(RecruitmentApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;

  readonly saved = output<InterviewOutcome>();
  readonly failed = output<MoveFailure>();

  readonly busy = signal(false);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = { ...ERROR_KEYS, pattern: 'recruitment.errors.time', interviewersMax: 'recruitment.errors.interviewersMax' };
  protected readonly modes = INTERVIEW_MODES;
  protected readonly bounds = { min: DURATION_MIN, max: DURATION_MAX, interviewers: INTERVIEWERS_MAX };
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly form = this.fb.group({
    date: ['', [Validators.required, isoDate]],
    time: ['', [Validators.required, Validators.pattern(TIME_PATTERN)]],
    durationMinutes: [DURATION_DEFAULT, wholeNumber(DURATION_MIN, DURATION_MAX)],
    mode: this.fb.control<InterviewMode>('on_site'),
    location: ['', text(1, LOCATION_MAX, false)],
    label: ['', text(1, LABEL_MAX, false)],
    interviewerIds: this.fb.control<readonly string[]>([], oneToFive),
  });
  protected readonly cancelForm = this.fb.group({ reason: ['', text(CANCEL_REASON_MIN, CANCEL_REASON_MAX)] });

  // --- Interviewers: chips + a search among the company's active users ---

  protected readonly chosen = signal<readonly UserRef[]>([]);
  protected readonly results = signal<readonly InterviewerOption[]>([]);
  protected readonly searchState = signal<'idle' | 'loading' | 'done' | 'error'>('idle');
  private readonly searches = new Subject<string>();

  constructor() {
    this.searches
      .pipe(
        debounceTime(INTERVIEWER_SEARCH_DEBOUNCE_MS),
        switchMap((q) => {
          if (q.length < SEARCH_MIN) return of<readonly InterviewerOption[]>([]).pipe(map((items) => ({ items, state: 'idle' as const })));
          this.searchState.set('loading');
          return this.api.interviewers(q).pipe(
            map((items) => ({ items, state: 'done' as const })),
            catchError(() => of({ items: [] as readonly InterviewerOption[], state: 'error' as const })),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe(({ items, state }) => {
        this.results.set(items);
        this.searchState.set(state);
      });
  }

  protected available(): readonly InterviewerOption[] {
    const taken = new Set(this.chosen().map((user) => user.id));
    return this.results().filter((option) => !taken.has(option.id));
  }

  protected onSearch(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value.trim() : '');
  }

  protected add(option: InterviewerOption, search: HTMLInputElement): void {
    if (this.chosen().length >= INTERVIEWERS_MAX) return;
    this.setChosen([...this.chosen(), { id: option.id, displayName: option.displayName }]);
    search.value = '';
    this.results.set([]);
    this.searchState.set('idle');
    search.focus();
  }

  protected remove(user: UserRef): void {
    this.setChosen(this.chosen().filter((u) => u.id !== user.id));
  }

  private setChosen(users: readonly UserRef[]): void {
    this.chosen.set(users);
    const control = this.form.controls.interviewerIds;
    control.setValue(users.map((u) => u.id));
    control.markAsTouched();
  }

  // --- Opening the dialog ---

  schedule(subject: InterviewSubject): void {
    this.form.reset();
    this.chosen.set([]);
    this.show({ kind: 'schedule', subject });
  }

  edit(interview: InterviewView, name: string): void {
    const interviewers = interview.evaluations.map((e) => e.interviewer);
    this.form.reset({
      date: interview.date,
      time: interview.time,
      durationMinutes: interview.durationMinutes,
      mode: interview.mode,
      location: interview.location ?? '',
      label: interview.label ?? '',
      interviewerIds: interviewers.map((u) => u.id),
    });
    this.chosen.set(interviewers);
    this.show({ kind: 'edit', interview, name });
  }

  cancel(interview: InterviewView, name: string): void {
    this.cancelForm.reset({ reason: '' });
    this.show({ kind: 'cancel', interview, name });
  }

  private show(pending: Pending): void {
    this.formError.set(null);
    this.results.set([]);
    this.searchState.set('idle');
    this.pending.set(pending);
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  // --- Saving ---

  private input(): InterviewInput {
    const v = this.form.getRawValue();
    return {
      date: v.date,
      time: v.time,
      durationMinutes: Number(v.durationMinutes),
      mode: v.mode,
      location: v.location.trim() || null,
      label: v.label.trim() || null,
      interviewerIds: v.interviewerIds,
    };
  }

  protected save(): void {
    const p = this.pending();
    if (!p || p.kind === 'cancel') return;
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const next = this.input();
    if (p.kind === 'schedule') {
      this.run(this.api.scheduleInterview(p.subject.applicationId, next), 'scheduled', p.subject.name, this.form);
      return;
    }
    // Only what changed: a new date, time or place tells the interviewers again, an untouched one must not.
    const before = p.interview;
    const patch: { -readonly [K in keyof InterviewInput]?: InterviewInput[K] } = {};
    if (next.date !== before.date || next.time !== before.time) {
      patch.date = next.date;
      patch.time = next.time;
    }
    if (next.durationMinutes !== before.durationMinutes) patch.durationMinutes = next.durationMinutes;
    if (next.mode !== before.mode) patch.mode = next.mode;
    if (next.location !== before.location) patch.location = next.location;
    if (next.label !== before.label) patch.label = next.label;
    if (!sameIds(next.interviewerIds, before.evaluations.map((e) => e.interviewer.id))) patch.interviewerIds = next.interviewerIds;
    if (Object.keys(patch).length === 0) {
      this.close();
      return;
    }
    this.run(this.api.updateInterview(before.id, patch), 'updated', p.name, this.form);
  }

  protected confirmCancel(): void {
    const p = this.pending();
    if (!p || p.kind !== 'cancel') return;
    this.formError.set(null);
    if (this.cancelForm.invalid) {
      this.cancelForm.markAllAsTouched();
      return;
    }
    this.run(this.api.cancelInterview(p.interview.id, this.cancelForm.getRawValue().reason.trim()), 'cancelled', p.name, this.cancelForm);
  }

  private run(request$: Observable<InterviewView>, kind: InterviewOutcome['kind'], name: string, form: typeof this.form | typeof this.cancelForm): void {
    this.busy.set(true);
    request$.subscribe({
      next: (interview) => {
        this.busy.set(false);
        this.close();
        this.saved.emit({ interview, kind, name });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        // The application left the interview stages, the opening closed, the interview was cancelled meanwhile…
        if (isStale(error)) {
          this.close();
          this.failed.emit({ key: actionErrorKey(error), reload: true });
          return;
        }
        this.formError.set(recruitmentProblemToForm(form, withoutFieldIndex(error, 'interviewerIds')));
      },
    });
  }
}
