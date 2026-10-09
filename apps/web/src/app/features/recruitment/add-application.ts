import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { catchError, last, map, type Observable, of, switchMap } from 'rxjs';
import { Session } from '../../core/auth/session';
import { EMPLOYEE_FILE_ACCEPT, EMPLOYEE_FILE_MAX_BYTES, titleFromFileName } from '../../core/employee-files/employee-files.models';
import { isApiProblemError } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type ApplicationDetailView,
  type CandidateMatchView,
  COMMENT_MAX,
  type MatchResult,
  matchQueryOf,
  type NewApplication,
  type Source,
  SOURCES,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { CandidateFields, candidateForm } from './candidate-fields';
import { KnownPersonNote } from './known-person-note';
import {
  acceptedFile,
  clearServerErrors,
  ERROR_KEYS,
  money,
  normaliseMoney,
  recruitmentProblemToForm,
  text,
  toCandidateInput,
  withoutFieldPrefix,
} from './recruitment-forms';
import { slugOf } from './recruitment-view';

export interface AddedApplication {
  readonly application: ApplicationDetailView;
  /** The application exists but its CV could not be stored (it can be added from the candidate page). */
  readonly uploadFailed: boolean;
}

/** The duplicate fields of a 409 `recruitment-candidate-duplicate`. A NIN duplicate can never be overridden. */
export function duplicateFields(error: unknown): readonly string[] {
  if (!isApiProblemError(error) || slugOf(error) !== 'recruitment-candidate-duplicate') return [];
  return (error.problem.errors ?? []).filter((e) => e.code === 'duplicate').map((e) => e.field);
}

/**
 * Add an application to an opening in two steps: who (a new record, or an existing one found by the duplicate
 * search), then the application itself (source, expected salary, CV, information notice).
 */
@Component({
  selector: 'app-add-application',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe, DisplayNamePipe, FileSizePipe, ControlError, RevealAlert, CandidateFields, KnownPersonNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './add-application.html',
  styleUrl: './recruitment.css',
})
export class AddApplication {
  private readonly api = inject(RecruitmentApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canSalary = inject(Session).can('recruitment.salary.update');

  readonly openingId = input.required<string>();
  readonly added = output<AddedApplication>();
  readonly cancelled = output<void>();

  protected readonly step = signal<1 | 2>(1);
  protected readonly identity = candidateForm(this.fb);
  protected readonly details = this.fb.group({
    source: this.fb.control<Source>('spontaneous'),
    expectedSalary: ['', money],
    comment: ['', text(1, COMMENT_MAX, false)],
    file: this.fb.control<File | null>(null, acceptedFile),
  });

  protected readonly sources = SOURCES;
  protected readonly accept = EMPLOYEE_FILE_ACCEPT;
  protected readonly maxBytes = EMPLOYEE_FILE_MAX_BYTES;
  protected readonly errorKeys = ERROR_KEYS;

  protected readonly matches = signal<MatchResult | null>(null);
  protected readonly matching = signal(false);
  /** The existing record HR chose instead of creating a new one. */
  protected readonly existing = signal<CandidateMatchView | null>(null);
  protected readonly file = signal<File | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  /** Set by a 409 on e-mail / phone only: the save button becomes « Enregistrer quand même ». */
  protected readonly overridable = signal(false);
  /** What the last duplicate search was run on, so the same values are not searched twice. */
  private searched = '';

  protected lookup(): void {
    if (this.existing()) return;
    const query = matchQueryOf(this.identity.getRawValue());
    const signature = JSON.stringify(query ?? null);
    if (!query || signature === this.searched) return;
    this.searched = signature;
    this.matching.set(true);
    this.api.match(query).subscribe({
      next: (result) => {
        this.matching.set(false);
        // A slower answer about values the user has since changed says nothing about what is typed now.
        if (signature === this.searched) this.matches.set(result);
      },
      // The search is a help: saving still checks duplicates on the server.
      error: () => this.matching.set(false),
    });
  }

  protected use(match: CandidateMatchView): void {
    this.existing.set(match);
    this.formError.set(null);
    this.step.set(2);
  }

  protected newRecord(): void {
    this.existing.set(null);
    this.step.set(1);
  }

  protected next(): void {
    this.formError.set(null);
    if (this.identity.invalid) {
      this.identity.markAllAsTouched();
      return;
    }
    // Before going on, make sure the search covered what is typed now; matches found by it keep the user on this
    // step once (a second « Continuer » confirms a new record).
    const query = matchQueryOf(this.identity.getRawValue());
    const signature = JSON.stringify(query ?? null);
    if (!query || signature === this.searched) {
      this.step.set(2);
      return;
    }
    this.searched = signature;
    this.matching.set(true);
    this.api.match(query).subscribe({
      next: (result) => {
        this.matching.set(false);
        this.matches.set(result);
        if (!result.candidates.length) this.step.set(2);
      },
      error: () => {
        this.matching.set(false);
        this.step.set(2);
      },
    });
  }

  protected onFileInput(event: Event): void {
    const chosen = event.target instanceof HTMLInputElement ? (event.target.files?.[0] ?? null) : null;
    this.details.controls.file.setValue(chosen);
    this.details.controls.file.markAsTouched();
    this.file.set(chosen);
  }

  protected submit(allowDuplicate = false): void {
    this.formError.set(null);
    if (allowDuplicate) clearServerErrors(this.identity);
    if (this.details.invalid || (!this.existing() && this.identity.invalid)) {
      this.details.markAllAsTouched();
      this.identity.markAllAsTouched();
      if (!this.existing() && this.identity.invalid) this.step.set(1);
      return;
    }
    const v = this.details.getRawValue();
    const existing = this.existing();
    const comment = v.comment.trim();
    const body: NewApplication = {
      ...(existing
        ? { candidateId: existing.id }
        : { candidate: toCandidateInput(this.identity.getRawValue()), ...(allowDuplicate ? { allowDuplicate: true } : {}) }),
      source: v.source,
      ...(this.canSalary && v.expectedSalary.trim() ? { expectedSalary: normaliseMoney(v.expectedSalary) } : {}),
      ...(comment ? { comment } : {}),
    };
    this.saving.set(true);
    this.api
      .addApplication(this.openingId(), body)
      .pipe(switchMap((application) => this.uploadCv(application, v.file)))
      .subscribe({
        next: (result) => {
          this.saving.set(false);
          this.added.emit(result);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.onSaveError(error);
        },
      });
  }

  /** The CV goes to the candidate once the application exists; a failed upload must not lose the application. */
  private uploadCv(application: ApplicationDetailView, file: File | null): Observable<AddedApplication> {
    if (!file) return of({ application, uploadFailed: false });
    return this.api.uploadFile(application.candidate.id, { kind: 'cv', title: titleFromFileName(file.name) || 'CV' }, file).pipe(
      last(),
      map(() => ({ application, uploadFailed: false })),
      catchError(() => of({ application, uploadFailed: true })),
    );
  }

  private onSaveError(raw: unknown): void {
    const error = withoutFieldPrefix(raw, 'candidate.');
    const duplicates = duplicateFields(error);
    if (duplicates.length) {
      // The duplicate fields live on step 1; e-mail / phone may be kept on purpose (relatives share a phone).
      this.formError.set(recruitmentProblemToForm(this.identity, error));
      this.overridable.set(!duplicates.includes('nin'));
      if (duplicates.includes('nin')) this.step.set(1);
      if (!this.formError()) this.formError.set({ key: duplicates.includes('nin') ? 'recruitment.errors.ninDuplicate' : 'recruitment.add.duplicateContact' });
      return;
    }
    this.overridable.set(false);
    const message = recruitmentProblemToForm(this.details, error);
    // Errors on identity fields (422) belong to step 1.
    if (message && isApiProblemError(error) && error.problem.errors?.some((e) => this.identity.get(e.field))) {
      this.step.set(1);
      this.formError.set(recruitmentProblemToForm(this.identity, error));
      return;
    }
    this.formError.set(message);
  }
}
