/**
 * `<app-contract-decision-panel>` — the body of a contract-decision task in My tasks (contracts-deadlines.md ›
 * Contract decisions): the employee and the fixed-term contract that ends, the proposal recorded so far, and the
 * proposal form (renew with a new end date / convert to CDI / end, a comment) saved with
 * `PUT /contract-decisions/:id/proposal`. The unit head proposes at the manager step; HR sees the proposal at its own
 * step and may change it before approving, which applies it. Approve / Reject stay the page's buttons: `dirtyChange`
 * tells the page when the form holds unsaved changes (approving then would apply the saved proposal, not the form).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';
import { DeadlinesApi } from '../../core/deadlines/deadlines-api';
import {
  addDays,
  type ContractDecisionView,
  DECISION_COMMENT_MAX,
  DECISION_PROPOSALS,
  type DecisionProposal,
  type ProposalBody,
} from '../../core/deadlines/deadlines.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import type { ContractDecisionTaskSubject } from '../../core/tasks/tasks.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';

/** Renew needs an end date, after the start when one is given (a group error: it reads two controls). */
function proposalDates(group: AbstractControl): ValidationErrors | null {
  if (group.get('proposal')?.value !== 'renew') return null;
  const start = group.get('proposedStartDate')?.value as string;
  const end = group.get('proposedEndDate')?.value as string;
  if (!end) return { endRequired: true };
  if (start && end <= start) return { endAfterStart: true };
  return null;
}

const ERROR_KEYS = { maxlength: 'tasks.decision.errors.commentTooLong' } as const;

@Component({
  selector: 'app-contract-decision-panel',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, DisplayNamePipe, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let s = subject();
      <dl class="facts" data-panel="contract-decision">
        <dt>{{ t('documents.fields.employee') }}</dt>
        <dd data-field="employee"><bdi>{{ s.employee.person | displayName: lang() }}</bdi> <span class="code">({{ s.employee.matricule }})</span></dd>
        @if (s.employee.unit; as unit) {
          <dt>{{ t('documents.fields.unit') }}</dt>
          <dd><bdi>{{ unit | displayName: lang() }}</bdi></dd>
        }
        <dt>{{ t('tasks.decision.contract') }}</dt>
        <dd data-field="contract">
          {{ t('contracts.type.' + s.contract.contractType) }} ·
          @if (s.contract.endDate) {
            {{ t('deadlines.range', { from: (s.contract.startDate | date: 'mediumDate' : undefined : locale()), to: (s.contract.endDate | date: 'mediumDate' : undefined : locale()) }) }}
          } @else {
            {{ t('deadlines.since', { from: (s.contract.startDate | date: 'mediumDate' : undefined : locale()) }) }}
          }
        </dd>
        <dt>{{ t('tasks.decision.current') }}</dt>
        <dd data-field="proposal">
          @if (s.proposal) {
            {{ proposalText(s.proposal, s.proposedStartDate, s.proposedEndDate) }}
            @if (s.comment) {
              <br /><bdi class="prose">{{ s.comment }}</bdi>
            }
          } @else {
            <span class="muted">{{ t('tasks.decision.none') }}</span>
          }
        </dd>
      </dl>

      <form [formGroup]="form" (ngSubmit)="save()" novalidate data-form="decision-proposal">
        <fieldset>
          <legend>{{ t(stepKey() === 'hr' ? 'tasks.decision.legendHr' : 'tasks.decision.legendManager') }}</legend>
          @for (p of proposals; track p) {
            <div class="check">
              <input type="radio" [id]="'decision-proposal-' + p" formControlName="proposal" [value]="p" [attr.data-proposal]="p" />
              <label [for]="'decision-proposal-' + p">{{ t('tasks.decision.proposals.' + p) }}</label>
            </div>
          }
          @if (proposalMissing()) {
            <p class="field-error" data-error="proposal">{{ t('tasks.decision.errors.proposalRequired') }}</p>
          }
        </fieldset>
        @let c = form.controls;
        @if (c.proposal.value === 'renew' || c.proposal.value === 'convert_cdi') {
          <div class="field">
            <label for="decision-start">{{ t('tasks.decision.start') }}</label>
            <input id="decision-start" type="date" formControlName="proposedStartDate" aria-describedby="decision-start-hint" />
            <p class="field-hint" id="decision-start-hint">{{ t('tasks.decision.startHint') }}</p>
          </div>
        }
        @if (c.proposal.value === 'renew') {
          <div class="field">
            <label for="decision-end">{{ t('tasks.decision.end') }}</label>
            <input id="decision-end" type="date" formControlName="proposedEndDate" required aria-describedby="decision-end-error"
              [attr.aria-invalid]="endError() !== null" />
            @if (endError(); as key) {
              <p class="field-error" id="decision-end-error" data-error="end">{{ t(key) }}</p>
            }
            <app-control-error [control]="c.proposedEndDate" errorId="decision-end-server-error" [keys]="errorKeys" />
          </div>
        }
        <div class="field">
          <label for="decision-comment">{{ t('tasks.decision.comment') }}</label>
          <textarea id="decision-comment" formControlName="comment" rows="3" dir="auto" [attr.maxlength]="commentMax" aria-describedby="decision-comment-error"></textarea>
          <app-control-error [control]="c.comment" errorId="decision-comment-error" [keys]="errorKeys" />
        </div>
        @if (formError(); as error) {
          <p class="form-error" role="alert" data-error="proposal-form">{{ 'key' in error ? t(error.key) : error.text }}</p>
        }
        @if (savedKey(); as key) {
          <p class="feedback" role="status" data-feedback="proposal">{{ t(key) }}</p>
        }
        <div class="form-actions">
          <button class="btn secondary" type="submit" data-action="save-proposal" [disabled]="saving()">{{ t('tasks.decision.save') }}</button>
        </div>
      </form>
      <p class="field-hint" data-hint="approve">
        @if (!s.proposal) {
          {{ t('tasks.decision.approveNeedsProposal') }}
        } @else if (stepKey() === 'hr') {
          {{ t('tasks.decision.approveApplies', { what: proposalText(s.proposal, s.proposedStartDate, s.proposedEndDate) }) }}
        } @else {
          {{ t('tasks.decision.approveSends') }}
        }
      </p>
    </ng-container>
  `,
  styles: `
    fieldset { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    legend { padding-inline: var(--space-1); font-weight: 600; }
  `,
})
export class ContractDecisionPanel {
  private readonly api = inject(DeadlinesApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  private readonly datePipe = new DatePipe('fr');

  readonly subject = input.required<ContractDecisionTaskSubject>();
  /** The task's step: `manager` (unit head) or `hr`. */
  readonly stepKey = input.required<string>();
  readonly saved = output<ContractDecisionView>();
  readonly dirtyChange = output<boolean>();

  protected readonly proposals = DECISION_PROPOSALS;
  protected readonly commentMax = DECISION_COMMENT_MAX;
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly savedKey = signal<string | null>(null);
  protected readonly proposalMissing = signal(false);
  /** Shown once the user tried to save or touched the end date. */
  protected readonly submitted = signal(false);
  private readonly formStatus = signal(0);
  protected readonly endError = computed(() => {
    this.formStatus();
    const touched = this.submitted() || this.form.controls.proposedEndDate.touched;
    if (!touched) return null;
    if (this.form.hasError('endRequired')) return 'tasks.decision.errors.endRequired';
    if (this.form.hasError('endAfterStart')) return 'tasks.decision.errors.endAfterStart';
    return null;
  });

  protected readonly form = this.fb.group(
    {
      proposal: this.fb.control<DecisionProposal | ''>(''),
      proposedStartDate: [''],
      proposedEndDate: [''],
      comment: ['', [Validators.maxLength(DECISION_COMMENT_MAX)]],
    },
    { validators: proposalDates },
  );

  constructor() {
    // A new task (or a refreshed summary of this one) fills the form with what is recorded.
    effect(() => {
      const s = this.subject();
      untracked(() => {
        const defaultStart = s.contract.endDate ? addDays(s.contract.endDate, 1) : '';
        this.form.reset({
          proposal: s.proposal ?? '',
          proposedStartDate: s.proposedStartDate ?? defaultStart,
          proposedEndDate: s.proposedEndDate ?? '',
          comment: s.comment ?? '',
        });
        this.formError.set(null);
        this.proposalMissing.set(false);
        this.submitted.set(false);
        this.dirtyChange.emit(false);
      });
    });
    this.form.events.pipe(takeUntilDestroyed()).subscribe(() => this.formStatus.update((n) => n + 1));
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.savedKey.set(null);
      if (this.form.controls.proposal.value) this.proposalMissing.set(false);
      this.dirtyChange.emit(this.form.dirty);
    });
  }

  /** « Renouvellement du 1 juil. 2027 au 30 juin 2028 », « Passage en CDI à partir du … », « Fin du contrat ». */
  protected proposalText(proposal: DecisionProposal, start: string | null, end: string | null): string {
    const fmt = (iso: string | null) => (iso ? (this.datePipe.transform(iso, 'mediumDate', undefined, this.locale()) ?? iso) : '…');
    return this.translate(`tasks.decision.summary.${proposal}`, { from: fmt(start), to: fmt(end) });
  }

  private readonly transloco = inject(TranslocoService);
  private translate(key: string, params: Record<string, string>): string {
    return this.transloco.translate(key, params);
  }

  protected save(): void {
    this.formError.set(null);
    this.savedKey.set(null);
    const v = this.form.getRawValue();
    if (!v.proposal) {
      this.proposalMissing.set(true);
      return;
    }
    this.submitted.set(true);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const comment = v.comment.trim();
    const body: ProposalBody = {
      proposal: v.proposal,
      ...(v.proposal !== 'end' && v.proposedStartDate ? { proposedStartDate: v.proposedStartDate } : {}),
      ...(v.proposal === 'renew' ? { proposedEndDate: v.proposedEndDate } : {}),
      ...(comment ? { comment } : {}),
    };
    this.saving.set(true);
    this.api.propose(this.subject().id, body).subscribe({
      next: (view) => {
        this.saving.set(false);
        this.savedKey.set('tasks.decision.saved');
        this.form.markAsPristine();
        this.dirtyChange.emit(false);
        this.saved.emit(view);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, {}, 'tasks.problems.notCandidate'));
      },
    });
  }
}
