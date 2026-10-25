/**
 * The HR family form of the « Coordonnées et famille » tab (`PUT /employees/:id/family`): marital status, its date,
 * whether the spouse works, and the full list of dependent children in one form — rows with an `id` are updated,
 * rows without one created, rows removed here deleted (profile-changes contract › Employment additions).
 *   <app-family-form [employmentId]="e.id" [family]="p.family" (saved)="…" (cancelled)="…" />
 */
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  Injector,
  inject,
  input,
  type OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map } from 'rxjs';
import { todayIso } from '../../core/date/iso-date';
import type { FormMessage } from '../../core/http/problem-form';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  type ChildSex,
  type ChildView,
  type FamilyView,
  MARITAL_STATUSES,
  type MaritalStatus,
  PROFILE_LIMITS,
  SPOUSE_EMPLOYED_VALUES,
  type SpouseEmployed,
} from '../../core/profile/profile.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { employeeProblemToForm, isoDate, notBlank } from './employee-forms';
import { FieldError } from './field-error';
import { familyBody, notFuture, PERSONAL_CODE_KEYS, PERSONAL_SLUGS } from './personal-forms';

function childGroup(fb: NonNullableFormBuilder, child?: ChildView) {
  return fb.group({
    id: [child?.id ?? ''],
    firstName: [child?.firstName ?? '', [Validators.required, notBlank, Validators.maxLength(PROFILE_LIMITS.childFirstName)]],
    birthDate: [child?.birthDate ?? '', [Validators.required, isoDate, notFuture()]],
    sex: fb.control<ChildSex | ''>(child?.sex ?? ''),
    dependent: [child?.dependent ?? true],
  });
}

type ChildGroup = ReturnType<typeof childGroup>;

@Component({
  selector: 'app-family-form',
  imports: [ReactiveFormsModule, TranslocoDirective, FieldError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './family-form.html',
  styleUrls: ['./employees.css', './personal.css'],
})
export class FamilyForm implements OnInit {
  private readonly api = inject(ProfileApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly injector = inject(Injector);

  readonly employmentId = input.required<string>();
  readonly family = input.required<FamilyView>();
  readonly saved = output<string>();
  readonly cancelled = output<void>();

  protected readonly limits = PROFILE_LIMITS;
  protected readonly maritalStatuses = MARITAL_STATUSES;
  protected readonly spouseValues = SPOUSE_EMPLOYED_VALUES;
  protected readonly today = todayIso();
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    maritalStatus: this.fb.control<MaritalStatus | ''>(''),
    maritalStatusSince: ['', [isoDate, notFuture()]],
    spouseEmployed: this.fb.control<SpouseEmployed | ''>(''),
    children: this.fb.array<ChildGroup>([], [Validators.maxLength(PROFILE_LIMITS.children)]),
  });
  protected readonly children = this.form.controls.children;
  protected readonly childCount = toSignal(this.children.valueChanges.pipe(map(() => this.children.length)), { initialValue: 0 });
  protected readonly full = computed(() => this.childCount() >= PROFILE_LIMITS.children);

  private readonly addButton = viewChild<ElementRef<HTMLButtonElement>>('addButton');
  private readonly childrenList = viewChild<ElementRef<HTMLElement>>('childrenList');

  ngOnInit(): void {
    const f = this.family();
    this.form.reset({ maritalStatus: f.maritalStatus ?? '', maritalStatusSince: f.maritalStatusSince ?? '', spouseEmployed: f.spouseEmployed ?? '' });
    for (const child of f.children) this.children.push(childGroup(this.fb, child));
  }

  /** Adds an empty row and moves focus to its first name. */
  protected addChild(): void {
    if (this.full()) return;
    this.children.push(childGroup(this.fb));
    const index = this.children.length - 1;
    afterNextRender(() => (this.childrenList()?.nativeElement.querySelector(`#child-${index}-name`) as HTMLElement | null)?.focus(), {
      injector: this.injector,
    });
  }

  /** Removes a row; focus goes back to « Ajouter un enfant » so it is not lost with the removed button. */
  protected removeChild(index: number): void {
    this.children.removeAt(index);
    afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set({ key: this.children.hasError('maxlength') ? 'personal.form.errors.tooManyChildren' : 'employees.create.fixErrors' });
      return;
    }
    const body = familyBody(this.form.getRawValue());
    this.submitting.set(true);
    this.api.updateFamily(this.employmentId(), body).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit('personal.feedback.familySaved');
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, PERSONAL_SLUGS, {}, undefined, PERSONAL_CODE_KEYS));
        this.submitting.set(false);
      },
    });
  }
}
