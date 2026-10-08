import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { OrgApi } from '../../core/org/org-api';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  ANEM_MAX,
  CLOSE_REASON_MAX,
  CLOSE_REASON_MIN,
  type OpeningAction,
  type OpeningDetailView,
  type OpeningPatch,
  POSTS_MIN,
  restorableCount,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { Timeline } from '../../shared/timeline/timeline';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { OpeningFacts } from './opening-facts';
import { PipelineBoard } from './pipeline-board';
import { ERROR_KEYS, isoDate, notBeforeDay, recruitmentProblemToForm, text, wholeNumber } from './recruitment-forms';
import { actionErrorKey, isNotFound, loadErrorKey, statusTone } from './recruitment-view';

export type OpeningTab = 'pipeline' | 'details' | 'history';

type Dialog = 'edit' | 'close' | 'reopen';

@Component({
  selector: 'app-opening-detail-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, ControlError, RevealAlert, Timeline, WorkflowStepper, OpeningFacts, PipelineBoard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './opening-detail.page.html',
  styleUrl: './recruitment.css',
})
export class OpeningDetailPage {
  private readonly api = inject(RecruitmentApi);
  private readonly router = inject(Router);
  private readonly catalog = inject(LeaveCatalog);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly id = input.required<string>();
  readonly tab = input<string>();
  /** `?created=1` after the request form: says the request was sent. */
  readonly created = input<string>();

  protected readonly opening = this.api.openingResource(this.id);
  protected readonly notFound = computed(() => isNotFound(this.opening.error()));
  protected readonly errorKey = computed(() => loadErrorKey(this.opening.error(), 'recruitment.opening.loadError'));

  /** The pipeline exists once the request was approved. */
  protected readonly hasPipeline = computed(() => {
    const status = this.opening.hasValue() ? this.opening.value().status : undefined;
    return status === 'open' || status === 'filled' || status === 'closed';
  });
  protected readonly tabs = computed<readonly OpeningTab[]>(() => (this.hasPipeline() ? ['pipeline', 'details', 'history'] : ['details', 'history']));
  protected readonly active = computed<OpeningTab>(() => {
    const tabs = this.tabs();
    const wanted = this.tab() as OpeningTab | undefined;
    return wanted && tabs.includes(wanted) ? wanted : (tabs[0] ?? 'details');
  });

  protected readonly feedback = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly board = viewChild(PipelineBoard);

  protected can(opening: OpeningDetailView, action: OpeningAction): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return opening._actions.includes(action);
  }

  protected selectTab(tab: OpeningTab): void {
    void this.router.navigate([], { queryParams: { tab, created: null }, queryParamsHandling: 'merge' });
  }

  protected refresh(): void {
    this.opening.reload();
    this.board()?.reload();
  }

  // --- Dialogs: edit (date, site, ANEM, fewer posts), close with a reason, reopen ---

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly dialogKind = signal<Dialog | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly tone = statusTone;
  private readonly today = algiersToday();

  private readonly wantSites = signal(false);
  private readonly canSites = inject(Session).allows('site.read');
  protected readonly sites = inject(OrgApi).sitesResource(() => undefined, () => this.wantSites() && this.canSites());

  protected readonly editForm = this.fb.group({
    targetDate: ['', [Validators.required, isoDate]],
    siteId: [''],
    anemReference: ['', text(1, ANEM_MAX, false)],
    posts: [1, wholeNumber(POSTS_MIN, 99)],
  });
  protected readonly closeForm = this.fb.group({ reason: ['', text(CLOSE_REASON_MIN, CLOSE_REASON_MAX)] });
  /** How many applications a reopening brings back; null while unknown. */
  protected readonly restorable = signal<number | null>(null);
  protected readonly postsBounds = signal({ min: POSTS_MIN, max: POSTS_MIN });

  protected openEdit(o: OpeningDetailView): void {
    this.wantSites.set(true);
    // Posts can only go down, and never below the hires already made.
    const bounds = { min: Math.max(POSTS_MIN, o.hiredCount), max: o.posts };
    this.postsBounds.set(bounds);
    this.editForm.controls.posts.setValidators(wholeNumber(bounds.min, bounds.max));
    this.editForm.controls.targetDate.setValidators([Validators.required, isoDate, notBeforeDay(() => (o.targetDate < this.today ? o.targetDate : this.today))]);
    this.editForm.reset({
      targetDate: o.targetDate,
      siteId: o.siteInherited ? '' : (o.site?.id ?? ''),
      anemReference: o.anemReference ?? '',
      posts: o.posts,
    });
    this.show('edit');
  }

  protected openClose(): void {
    this.closeForm.reset({ reason: '' });
    this.show('close');
  }

  protected openReopen(o: OpeningDetailView): void {
    this.restorable.set(null);
    this.show('reopen');
    this.api.board(o.id, true).subscribe({
      next: (board) => this.restorable.set(restorableCount(board)),
      // The count is a courtesy: the confirmation still works without it.
      error: () => this.restorable.set(null),
    });
  }

  private show(kind: Dialog): void {
    this.feedback.set(null);
    this.actionError.set(null);
    this.formError.set(null);
    this.dialogKind.set(kind);
    this.dialog().nativeElement.showModal();
  }

  protected closeDialog(): void {
    this.dialog().nativeElement.close();
  }

  protected onDialogClosed(): void {
    this.dialogKind.set(null);
    this.saving.set(false);
  }

  protected saveEdit(o: OpeningDetailView): void {
    this.formError.set(null);
    if (this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return;
    }
    const v = this.editForm.getRawValue();
    // Only what changed: `posts` unchanged must not be sent (the API reads any value as a change request).
    const currentSite = o.siteInherited ? '' : (o.site?.id ?? '');
    const anem = v.anemReference.trim();
    const patch: { -readonly [K in keyof OpeningPatch]: OpeningPatch[K] } = {};
    if (v.targetDate !== o.targetDate) patch.targetDate = v.targetDate;
    if (v.siteId !== currentSite) patch.siteId = v.siteId || null;
    if (anem !== (o.anemReference ?? '')) patch.anemReference = anem || null;
    if (Number(v.posts) !== o.posts) patch.posts = Number(v.posts);
    if (Object.keys(patch).length === 0) {
      this.closeDialog();
      return;
    }
    this.saving.set(true);
    this.api.updateOpening(o.id, patch).subscribe({
      next: (updated) => this.done(updated.status === 'filled' ? 'recruitment.opening.filledNow' : 'recruitment.opening.saved'),
      error: (error: unknown) => this.fail(this.editForm, error),
    });
  }

  protected saveClose(o: OpeningDetailView): void {
    this.formError.set(null);
    if (this.closeForm.invalid) {
      this.closeForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.api.closeOpening(o.id, this.closeForm.getRawValue().reason.trim()).subscribe({
      next: () => this.done('recruitment.opening.closedNow'),
      error: (error: unknown) => this.fail(this.closeForm, error),
    });
  }

  protected confirmReopen(o: OpeningDetailView): void {
    this.saving.set(true);
    this.api.reopenOpening(o.id).subscribe({
      next: () => this.done('recruitment.opening.reopenedNow'),
      error: (error: unknown) => {
        this.closeDialog();
        this.actionError.set(actionErrorKey(error));
        this.refresh();
      },
    });
  }

  private done(key: string): void {
    this.closeDialog();
    this.feedback.set(key);
    this.refresh();
  }

  private fail(form: typeof this.editForm | typeof this.closeForm, error: unknown): void {
    this.saving.set(false);
    this.formError.set(recruitmentProblemToForm(form, error));
  }

  // --- History tab: names for the ids the audit rows hold ---

  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    const o = this.opening.hasValue() ? this.opening.value() : undefined;
    if (!o) return undefined;
    if (kind === 'step') {
      const step = o.workflow?.steps.find((s) => s.key === value);
      return step ? this.catalog.labelOf(step.labels) : undefined;
    }
    if (kind === 'unit' && o.unit.id === value) return displayNameOf(o.unit, this.lang());
    if (kind === 'site' && o.site?.id === value) return o.site.name;
    if (kind === 'user') {
      if (o.requestedBy?.id === value) return o.requestedBy.displayName;
      if (o.closed?.by?.id === value) return o.closed.by.displayName;
    }
    return undefined;
  };
}
