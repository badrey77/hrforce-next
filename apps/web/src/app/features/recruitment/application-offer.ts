import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { Session } from '../../core/auth/session';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { type ApplicationDetailView, CANCEL_REASON_MAX, CANCEL_REASON_MIN, COMMENT_MAX } from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { OfferDialog, type OfferOutcome } from './offer-dialog';
import { ERROR_KEYS, recruitmentProblemToForm, text } from './recruitment-forms';
import { actionErrorKey, isStale } from './recruitment-view';
import type { MoveFailure } from './stage-move';

export type OfferEvent = 'made' | 'updated' | 'declined' | 'cancelled' | 'hire_undone';

export interface OfferChange {
  readonly kind: OfferEvent;
  readonly application: ApplicationDetailView;
  readonly name: string;
}

type Confirm = 'decline' | 'cancel' | 'undo';

const EMPLOYEE_CREATE = 'employee.create';

/**
 * The offer of one application: record, edit, « Offre déclinée », « Annuler l'offre », « Embaucher », and after the
 * hire the link to the employee and « Annuler l'embauche ». Every button comes from the application's `_actions`.
 */
@Component({
  selector: 'app-application-offer',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe, DecimalPipe, NgTemplateOutlet, DisplayNamePipe, ControlError, RevealAlert, OfferDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './application-offer.html',
  styleUrl: './recruitment.css',
})
export class ApplicationOffer {
  private readonly api = inject(RecruitmentApi);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly application = input.required<ApplicationDetailView>();
  readonly name = input.required<string>();
  readonly changed = output<OfferChange>();
  readonly failed = output<MoveFailure>();

  protected readonly offerDialog = viewChild.required(OfferDialog);
  private readonly confirmDialog = viewChild.required<ElementRef<HTMLDialogElement>>('confirmBox');
  protected readonly confirming = signal<Confirm | null>(null);
  protected readonly busy = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = ERROR_KEYS;
  /** The hire creates an employee: its page needs `employee.create` as well as the hire action. */
  protected readonly canCreateEmployee = this.session.allows(EMPLOYEE_CREATE);
  protected readonly canReadEmployee = this.session.allows('employee.read');

  protected readonly commentForm = this.fb.group({ comment: ['', text(1, COMMENT_MAX, false)] });
  protected readonly reasonForm = this.fb.group({ reason: ['', text(CANCEL_REASON_MIN, CANCEL_REASON_MAX)] });

  protected can(action: ApplicationDetailView['_actions'][number]): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return this.application()._actions.includes(action);
  }

  private subject() {
    const a = this.application();
    return { applicationId: a.id, stage: a.stage, name: this.name(), openingId: a.opening.id };
  }

  protected make(): void {
    this.offerDialog().make(this.subject());
  }

  protected edit(): void {
    const a = this.application();
    if (a.offer) this.offerDialog().edit(this.subject(), a.offer, a.salary?.proposed ?? null);
  }

  protected onSaved(outcome: OfferOutcome): void {
    this.changed.emit(outcome);
  }

  protected ask(kind: Confirm): void {
    this.formError.set(null);
    this.commentForm.reset({ comment: '' });
    this.reasonForm.reset({ reason: '' });
    this.confirming.set(kind);
    this.confirmDialog().nativeElement.showModal();
  }

  protected close(): void {
    this.confirmDialog().nativeElement.close();
  }

  protected confirm(): void {
    const kind = this.confirming();
    if (!kind) return;
    this.formError.set(null);
    const form = kind === 'undo' ? this.reasonForm : this.commentForm;
    if (form.invalid) {
      form.markAllAsTouched();
      return;
    }
    const a = this.application();
    let request$: Observable<ApplicationDetailView>;
    let done: OfferEvent;
    if (kind === 'undo') {
      request$ = this.api.undoHire(a.id, this.reasonForm.getRawValue().reason.trim());
      done = 'hire_undone';
    } else {
      request$ = this.api.endOffer(a.id, kind, this.commentForm.getRawValue().comment.trim() || null);
      done = kind === 'decline' ? 'declined' : 'cancelled';
    }
    this.busy.set(true);
    request$.subscribe({
      next: (application) => {
        this.busy.set(false);
        this.close();
        this.changed.emit({ kind: done, application, name: this.name() });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        if (isStale(error)) {
          this.close();
          this.failed.emit({ key: actionErrorKey(error), reload: true });
          return;
        }
        this.formError.set(recruitmentProblemToForm(form, error));
      },
    });
  }
}
