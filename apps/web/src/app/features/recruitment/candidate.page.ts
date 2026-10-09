import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type ApplicationDetailView,
  type CandidateView,
  NOTE_MAX,
  type NoteView,
  type ReasonRef,
  type Source,
  SOURCES,
  type Stage,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { duplicateFields } from './add-application';
import { ApplicationInterviews } from './application-interviews';
import { ApplicationOffer, type OfferChange } from './application-offer';
import type { InterviewOutcome } from './interview-dialog';
import { CandidateFields, candidateForm, candidateFormValue } from './candidate-fields';
import { CandidateFiles } from './candidate-files';
import { KnownPersonNote } from './known-person-note';
import { clearServerErrors, ERROR_KEYS, money, normaliseMoney, recruitmentProblemToForm, text, toCandidateInput } from './recruitment-forms';
import { actionErrorKey, isNotFound, loadErrorKey, stageTone } from './recruitment-view';
import { ApplicationMove, type MoveFailure, type MoveOutcome, StageMenu } from './stage-move';

type Editing = 'identity' | 'application' | null;

@Component({
  selector: 'app-candidate-page',
  imports: [
    TranslocoDirective,
    RouterLink,
    ReactiveFormsModule,
    DatePipe,
    DecimalPipe,
    DisplayNamePipe,
    ControlError,
    RevealAlert,
    CandidateFields,
    CandidateFiles,
    KnownPersonNote,
    StageMenu,
    ApplicationMove,
    ApplicationInterviews,
    ApplicationOffer,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './candidate.page.html',
  styleUrl: './recruitment.css',
})
export class CandidatePage {
  private readonly api = inject(RecruitmentApi);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly id = input.required<string>();
  /** `?application=<id>`: which of the candidate's applications is shown. */
  readonly application = input<string>();

  protected readonly candidate = this.api.candidateResource(this.id);
  protected readonly notFound = computed(() => isNotFound(this.candidate.error()));
  protected readonly errorKey = computed(() => loadErrorKey(this.candidate.error(), 'recruitment.candidate.loadError'));

  private readonly selectedId = computed(() => {
    if (!this.candidate.hasValue()) return undefined;
    const applications = this.candidate.value().applications;
    const wanted = this.application();
    return (applications.find((a) => a.id === wanted) ?? applications[0])?.id;
  });
  protected readonly detail = this.api.applicationResource(this.selectedId);
  protected readonly selected = computed<ApplicationDetailView | undefined>(() => (this.detail.hasValue() ? this.detail.value() : undefined));

  protected readonly feedback = signal<{ readonly key: string; readonly params?: Record<string, string> } | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly editing = signal<Editing>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly sources = SOURCES;
  protected readonly tone = stageTone;
  protected readonly mover = viewChild.required(ApplicationMove);

  protected nameOf(candidate: CandidateView): string {
    return displayNameOf(candidate.person, this.lang());
  }

  protected reasonLabel(reason: ReasonRef | null): string {
    return reason ? pickLabel(reason.labels, this.lang()) : '';
  }

  protected selectApplication(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.editing.set(null);
    void this.router.navigate([], { queryParams: { application: event.target.value }, queryParamsHandling: 'merge' });
  }

  private reset(): void {
    this.feedback.set(null);
    this.actionError.set(null);
    this.formError.set(null);
  }

  private reloadAll(): void {
    this.candidate.reload();
    this.detail.reload();
  }

  // --- Identity ---

  protected readonly identity = candidateForm(this.fb);
  /** Set by a 409 on e-mail / phone only: the form offers « Enregistrer quand même ». */
  protected readonly overridable = signal(false);

  protected editIdentity(candidate: CandidateView): void {
    this.reset();
    this.overridable.set(false);
    this.identity.reset(candidateFormValue(candidate));
    this.editing.set('identity');
  }

  protected saveIdentity(candidate: CandidateView, allowDuplicate = false): void {
    this.formError.set(null);
    if (allowDuplicate) clearServerErrors(this.identity);
    if (this.identity.invalid) {
      this.identity.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    const body = { ...toCandidateInput(this.identity.getRawValue()), ...(allowDuplicate ? { allowDuplicate: true } : {}) };
    this.api.updateCandidate(candidate.id, body).subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(null);
        this.feedback.set({ key: 'recruitment.candidate.saved' });
        this.reloadAll();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        const duplicates = duplicateFields(error);
        this.overridable.set(duplicates.length > 0 && !duplicates.includes('nin'));
        this.formError.set(recruitmentProblemToForm(this.identity, error) ?? (this.overridable() ? { key: 'recruitment.add.duplicateContact' } : null));
      },
    });
  }

  protected link(candidate: CandidateView, personId: string | null): void {
    this.reset();
    this.busy.set(true);
    this.api.linkPerson(candidate.id, personId).subscribe({
      next: () => {
        this.busy.set(false);
        this.feedback.set({ key: personId ? 'recruitment.known.linked' : 'recruitment.known.unlinked' });
        this.reloadAll();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(actionErrorKey(error));
      },
    });
  }

  // --- The selected application: stage, source and salary, notes ---

  protected move(candidate: CandidateView, application: ApplicationDetailView, target: Stage): void {
    this.reset();
    this.mover().move({ id: application.id, stage: application.stage, name: this.nameOf(candidate) }, target);
  }

  protected reopen(candidate: CandidateView, application: ApplicationDetailView): void {
    this.reset();
    this.mover().reopen({ id: application.id, stage: application.stage, name: this.nameOf(candidate) });
  }

  protected onMoved(outcome: MoveOutcome): void {
    this.feedback.set({ key: `recruitment.move.done.${outcome.application.stage}`, params: { name: outcome.name } });
    this.reloadAll();
  }

  protected onMoveFailed(failure: MoveFailure): void {
    this.actionError.set(failure.key);
    if (failure.reload) this.reloadAll();
  }

  protected onInterviewSaved(outcome: InterviewOutcome): void {
    this.actionError.set(null);
    this.feedback.set({ key: `recruitment.interviews.done.${outcome.kind}`, params: { name: outcome.name } });
    this.reloadAll();
  }

  protected onOfferChanged(change: OfferChange): void {
    this.actionError.set(null);
    this.feedback.set({ key: `recruitment.offer.done.${change.kind}`, params: { name: change.name } });
    this.reloadAll();
  }

  protected readonly applicationForm = this.fb.group({
    source: this.fb.control<Source>('spontaneous'),
    expectedSalary: ['', money],
  });

  protected editApplication(application: ApplicationDetailView): void {
    this.reset();
    this.applicationForm.reset({ source: application.source, expectedSalary: application.salary?.expected ?? '' });
    this.editing.set('application');
  }

  protected saveApplication(application: ApplicationDetailView): void {
    this.formError.set(null);
    if (this.applicationForm.invalid) {
      this.applicationForm.markAllAsTouched();
      return;
    }
    const v = this.applicationForm.getRawValue();
    const salary = v.expectedSalary.trim() ? normaliseMoney(v.expectedSalary) : null;
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    const maySetSalary = application._actions.includes('update_salary');
    const body = {
      ...(v.source !== application.source ? { source: v.source } : {}),
      // The salary is only sent by someone allowed to write it, and only when it changed.
      ...(maySetSalary && salary !== (application.salary?.expected ?? null) ? { expectedSalary: salary } : {}),
    };
    if (Object.keys(body).length === 0) {
      this.editing.set(null);
      return;
    }
    this.busy.set(true);
    this.api.updateApplication(application.id, body).subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(null);
        this.feedback.set({ key: 'recruitment.application.saved' });
        this.reloadAll();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.formError.set(recruitmentProblemToForm(this.applicationForm, error));
      },
    });
  }

  protected readonly noteForm = this.fb.group({ body: ['', text(1, NOTE_MAX)] });
  protected readonly noteError = signal<FormMessage | null>(null);

  protected addNote(application: ApplicationDetailView): void {
    this.noteError.set(null);
    if (this.noteForm.invalid) {
      this.noteForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.api.addNote(application.id, this.noteForm.getRawValue().body.trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.noteForm.reset({ body: '' });
        this.detail.reload();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.noteError.set(recruitmentProblemToForm(this.noteForm, error));
      },
    });
  }

  protected deleteNote(application: ApplicationDetailView, note: NoteView): void {
    this.reset();
    this.busy.set(true);
    this.api.deleteNote(application.id, note.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.detail.reload();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(actionErrorKey(error));
        this.detail.reload();
      },
    });
  }

  // --- Erasure on request (cannot be undone) ---

  private readonly eraseDialog = viewChild.required<ElementRef<HTMLDialogElement>>('eraseDialog');

  protected openErase(): void {
    this.reset();
    this.eraseDialog().nativeElement.showModal();
  }

  protected closeErase(): void {
    this.eraseDialog().nativeElement.close();
  }

  protected confirmErase(candidate: CandidateView): void {
    this.busy.set(true);
    this.api.eraseCandidate(candidate.id).subscribe({
      // Nothing is left to show: back to the list, which says so.
      next: () => void this.router.navigate(['/recruitment/candidates'], { queryParams: { erased: '1' } }),
      error: (error: unknown) => {
        this.busy.set(false);
        this.closeErase();
        this.actionError.set(actionErrorKey(error));
      },
    });
  }
}
