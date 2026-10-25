/**
 * /me/profile — « Mon profil » (docs/contracts/profile-changes.md › Web builder 2): identity read-only with
 * « Signaler une erreur », one card per section with « Modifier » (or the pending request and its cancel), and
 * « Mes demandes ». Needs `profile.request_self` (route guard) and an open linked employment (409
 * `profile-not-linked` otherwise). Laid out for 390 px first.
 */
import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoDirective } from '@jsverse/transloco';
import { BlobFiles } from '../../core/browser/blob-files';
import { downloadFileName } from '../../core/employee-files/employee-files.models';
import { isApiProblemError } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { NotificationEvents } from '../../core/notifications/notification-events';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  ageOn,
  type MyProfileView,
  PROFILE_PROBLEMS,
  type ProfileRequestFile,
  type ProfileRequestView,
  type ProfileSection,
  pendingOf,
  requestActions,
  sectionMode,
} from '../../core/profile/profile.models';
import { wilayaLabel } from '../../core/profile/wilayas';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import { ProfileBankForm } from './bank-form';
import { ProfileContactForm } from './contact-form';
import { ProfileEmergencyForm } from './emergency-form';
import { ProfileFamilyForm } from './family-form';
import { ProfileIdentityNoteForm } from './identity-note-form';
import { todayIso } from './profile-forms';

interface PendingRef {
  readonly id: string;
  readonly section: ProfileSection;
}

@Component({
  selector: 'app-my-profile-page',
  imports: [
    TranslocoDirective,
    DatePipe,
    DisplayNamePipe,
    FileSizePipe,
    WorkflowStepper,
    ProfileContactForm,
    ProfileEmergencyForm,
    ProfileFamilyForm,
    ProfileBankForm,
    ProfileIdentityNoteForm,
  ],
  providers: [BlobFiles],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-profile.page.html',
  styleUrl: './my-profile.page.css',
})
export class MyProfilePage {
  private readonly api = inject(ProfileApi);
  private readonly blobs = inject(BlobFiles);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  private readonly today = todayIso();

  /** `GET /me/profile` answered 409 `profile-not-linked`. */
  protected readonly profileRes = this.api.myProfileResource();

  protected readonly notLinked = computed(() => {
    const error = this.profileRes.error();
    return isApiProblemError(error) && (problemSlug(error.problem.type) === PROFILE_PROBLEMS.notLinked || error.status === 404);
  });
  protected readonly profile = computed<MyProfileView | null>(() => (this.profileRes.hasValue() ? this.profileRes.value() : null));
  /** A boolean signal: a reloaded profile does not refetch the requests a second time. */
  private readonly hasProfile = computed(() => this.profile() !== null);
  protected readonly requestsRes = this.api.myRequestsResource(() => this.hasProfile());
  protected readonly requests = computed<readonly ProfileRequestView[]>(() => (this.requestsRes.hasValue() ? this.requestsRes.value().items : []));

  /** The section whose form is open (one at a time). */
  protected readonly editing = signal<ProfileSection | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly fileError = signal<string | null>(null);

  protected readonly cardSections: readonly Exclude<ProfileSection, 'identity_note'>[] = ['contact', 'emergency', 'family', 'bank'];

  protected pending(section: ProfileSection): MyProfileView['pending'][number] | null {
    const profile = this.profile();
    return profile ? pendingOf(profile, section) : null;
  }

  protected modeOf(section: ProfileSection): string {
    const profile = this.profile();
    return profile ? sectionMode(profile.modes, section) : 'approval';
  }

  protected wilaya(code: string | null): string {
    return wilayaLabel(code, this.lang());
  }

  protected age(birthDate: string): number {
    return ageOn(birthDate, this.today);
  }

  protected canCancel(request: ProfileRequestView): boolean {
    return request.status === 'pending' && requestActions(request).includes('cancel');
  }

  protected edit(section: ProfileSection): void {
    this.feedback.set(null);
    this.editing.set(section);
    // The « Modifier » button that had the focus is replaced by the form: move the focus to its first field.
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>(`[data-card="${section}"] form :is(input, select, textarea):not([type="file"])`)?.focus(),
      { injector: this.injector },
    );
  }
  private readonly injector = inject(Injector);

  protected closeForm(): void {
    const section = this.editing();
    this.editing.set(null);
    if (section) this.focusCard(section);
  }

  protected onDone(request: ProfileRequestView): void {
    const section = request.section;
    this.editing.set(null);
    this.feedback.set(
      request.status === 'applied' ? 'profile.feedback.applied' : section === 'identity_note' ? 'profile.feedback.noteSent' : 'profile.feedback.requested',
    );
    this.reload();
    this.focusCard(section);
  }

  private reload(): void {
    this.profileRes.reload();
    this.requestsRes.reload();
  }

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  private focusCard(section: ProfileSection): void {
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-card="${section}"] h2`)?.focus({ preventScroll: false }));
  }

  // --- Files of my requests -----------------------------------------------------------------------------------------

  protected download(request: ProfileRequestView, file: ProfileRequestFile): void {
    this.fileError.set(null);
    this.blobs.save(this.api.myFile(request.id, file.id), downloadFileName(file.filename, file.mime)).subscribe({
      error: () => this.fileError.set('profile.requests.fileError'),
    });
  }

  // --- ?request= (notification links) -------------------------------------------------------------------------------

  readonly request = input<string | undefined>();
  protected readonly highlighted = computed(() => {
    const id = this.request();
    return id && this.requests().some((r) => r.id === id) ? id : null;
  });
  private scrolledTo: string | null = null;

  // --- Cancel dialog ------------------------------------------------------------------------------------------------

  private readonly cancelDialog = viewChild.required<ElementRef<HTMLDialogElement>>('cancelDialog');
  protected readonly cancelling = signal<PendingRef | null>(null);
  protected readonly cancelSubmitting = signal(false);
  protected readonly cancelError = signal<string | null>(null);

  constructor() {
    afterRenderEffect(() => {
      const id = this.highlighted();
      if (!id || id === this.scrolledTo) return;
      const item = this.host.nativeElement.querySelector<HTMLElement>(`[data-request="${CSS.escape(id)}"]`);
      if (!item) return;
      this.scrolledTo = id;
      item.scrollIntoView?.({ block: 'center' });
      item.focus({ preventScroll: true });
    });
    inject(NotificationEvents)
      .of((type) => type.startsWith('profile.'))
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.profile()) this.reload();
      });
  }

  protected openCancel(ref: PendingRef): void {
    this.feedback.set(null);
    this.cancelError.set(null);
    this.cancelling.set(ref);
    this.cancelDialog().nativeElement.showModal();
  }

  protected closeCancel(): void {
    this.cancelDialog().nativeElement.close();
  }

  protected onCancelClosed(): void {
    this.cancelling.set(null);
    this.cancelSubmitting.set(false);
  }

  protected confirmCancel(): void {
    const ref = this.cancelling();
    if (!ref) return;
    this.cancelSubmitting.set(true);
    this.api.cancel(ref.id).subscribe({
      next: () => {
        this.closeCancel();
        this.feedback.set('profile.feedback.cancelled');
        this.reload();
      },
      error: (error: unknown) => {
        this.cancelSubmitting.set(false);
        const conflict = isApiProblemError(error) && (error.status === 409 || error.status === 404);
        this.cancelError.set(conflict ? 'profile.problems.notCancellable' : 'errors.generic');
        if (conflict) this.reload();
      },
    });
  }
}
