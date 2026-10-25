import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type FormControl, type FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map } from 'rxjs';
import {
  blankToNull,
  type ChildInput,
  type ChildSex,
  type FamilyInput,
  familyNeedsProof,
  MARITAL_STATUSES,
  type MaritalStatus,
  type MyProfileView,
  PROFILE_LIMITS,
  type ProfileRequestView,
  sectionMode,
  SPOUSE_EMPLOYED_VALUES,
  type SpouseEmployed,
} from '../../core/profile/profile.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ProfileFieldError } from './profile-field-error';
import { acceptedFiles, notBlank, pastDate, RequestSubmission, todayIso } from './profile-forms';
import { RequestFooter } from './request-footer';

type ChildGroup = FormGroup<{
  id: FormControl<string | null>;
  firstName: FormControl<string>;
  birthDate: FormControl<string>;
  sex: FormControl<ChildSex | ''>;
  dependent: FormControl<boolean>;
}>;

@Component({
  selector: 'app-profile-family-form',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ProfileFieldError, RequestFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="family" [attr.aria-label]="t('profile.sections.family')">
      <p class="mode-note" data-field="mode">{{ t(mode() === 'approval' ? 'profile.mode.familyApproval' : 'profile.mode.immediate') }}</p>
      @if (submission.formError(); as error) {
        <p class="form-error" role="alert" data-error="form" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let p = form.controls.payload.controls;
      <div class="grid">
        <div class="field">
          <label for="family-status">{{ t('profile.fields.maritalStatus') }}</label>
          <select id="family-status" [formControl]="p.maritalStatus" aria-describedby="family-status-error">
            <option value="">{{ t('profile.form.notSet') }}</option>
            @for (s of statuses; track s) {
              <option [value]="s">{{ t('profile.maritalStatus.' + s) }}</option>
            }
          </select>
          <app-profile-field-error [control]="p.maritalStatus" errorId="family-status-error" />
        </div>
        <div class="field">
          <label for="family-since">{{ t('profile.fields.maritalStatusSince') }}</label>
          <input id="family-since" type="date" [formControl]="p.maritalStatusSince" [attr.max]="today"
            [attr.aria-invalid]="p.maritalStatusSince.invalid && p.maritalStatusSince.touched" aria-describedby="family-since-error" />
          <app-profile-field-error [control]="p.maritalStatusSince" errorId="family-since-error" />
        </div>
        <div class="field">
          <label for="family-spouse">{{ t('profile.fields.spouseEmployed') }}</label>
          <select id="family-spouse" [formControl]="p.spouseEmployed" aria-describedby="family-spouse-error">
            <option value="">{{ t('profile.form.notSet') }}</option>
            @for (s of spouseValues; track s) {
              <option [value]="s">{{ t('profile.spouseEmployed.' + s) }}</option>
            }
          </select>
          <app-profile-field-error [control]="p.spouseEmployed" errorId="family-spouse-error" />
        </div>
      </div>

      <h4 class="children-title">{{ t('profile.fields.children') }}</h4>
      @for (child of p.children.controls; track child; let i = $index) {
        @let c = child.controls;
        <fieldset class="child" [attr.data-child]="i">
          <legend>{{ t('profile.children.legend', { n: i + 1 }) }}</legend>
          <div class="grid">
            <div class="field">
              <label [for]="'child-name-' + i">{{ t('profile.fields.firstName') }}</label>
              <input [id]="'child-name-' + i" type="text" dir="auto" autocomplete="off" required [formControl]="c.firstName" [attr.maxlength]="limits.childFirstName"
                [attr.aria-invalid]="c.firstName.invalid && c.firstName.touched" [attr.aria-describedby]="'child-name-error-' + i" />
              <app-profile-field-error [control]="c.firstName" [errorId]="'child-name-error-' + i" />
            </div>
            <div class="field">
              <label [for]="'child-birth-' + i">{{ t('profile.fields.birthDate') }}</label>
              <input [id]="'child-birth-' + i" type="date" required [formControl]="c.birthDate" [attr.max]="today"
                [attr.aria-invalid]="c.birthDate.invalid && c.birthDate.touched" [attr.aria-describedby]="'child-birth-error-' + i" />
              <app-profile-field-error [control]="c.birthDate" [errorId]="'child-birth-error-' + i" />
            </div>
            <div class="field">
              <label [for]="'child-sex-' + i">{{ t('profile.fields.sex') }}</label>
              <select [id]="'child-sex-' + i" [formControl]="c.sex">
                <option value="">{{ t('profile.form.notSet') }}</option>
                <option value="F">{{ t('profile.childSex.F') }}</option>
                <option value="M">{{ t('profile.childSex.M') }}</option>
              </select>
            </div>
          </div>
          <div class="child-actions">
            <div class="check">
              <input [id]="'child-dependent-' + i" type="checkbox" [formControl]="c.dependent" />
              <label [for]="'child-dependent-' + i">{{ t('profile.fields.dependent') }}</label>
            </div>
            <button class="btn secondary" type="button" data-action="remove-child" [attr.aria-label]="t('profile.children.removeLabel', { n: i + 1 })"
              [disabled]="submission.busy()" (click)="removeChild(i)">{{ t('profile.children.remove') }}</button>
          </div>
        </fieldset>
      } @empty {
        <p class="muted" data-state="no-children">{{ t('profile.children.none') }}</p>
      }
      @if (p.children.length < limits.children) {
        <p><button class="btn secondary" type="button" data-action="add-child" [disabled]="submission.busy()" (click)="addChild()">{{ t('profile.children.add') }}</button></p>
      } @else {
        <p class="field-hint" data-state="max-children">{{ t('profile.children.max', { max: limits.children }) }}</p>
      }

      <app-request-footer [submission]="submission" [mode]="mode()" idPrefix="family" [comment]="form.controls.comment" [files]="form.controls.files"
        [filesRequired]="needsProof()" filesHintKey="profile.files.hintFamily" (closed)="closed.emit()" />
    </form>
  `,
  styles: `
    .mode-note { margin-block: 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--color-surface-alt); }
    .children-title { margin-block: var(--space-3) var(--space-2); font-size: 1rem; }
    .child { margin: 0 0 var(--space-3); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .child legend { padding-inline: var(--space-1); font-weight: 600; }
    .child-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
  `,
})
export class ProfileFamilyForm implements OnInit {
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly submission = new RequestSubmission();
  protected readonly limits = PROFILE_LIMITS;
  protected readonly statuses = MARITAL_STATUSES;
  protected readonly spouseValues = SPOUSE_EMPLOYED_VALUES;
  protected readonly today = todayIso();

  readonly profile = input.required<MyProfileView>();
  readonly done = output<ProfileRequestView>();
  readonly closed = output<void>();
  protected readonly mode = computed(() => sectionMode(this.profile().modes, 'family'));

  protected readonly form = this.fb.group({
    payload: this.fb.group({
      maritalStatus: this.fb.control<MaritalStatus | ''>(''),
      maritalStatusSince: ['', pastDate()],
      spouseEmployed: this.fb.control<SpouseEmployed | ''>(''),
      children: this.fb.array<ChildGroup>([]),
    }),
    comment: ['', Validators.maxLength(PROFILE_LIMITS.comment)],
    files: this.fb.control<File[]>([], acceptedFiles),
  });

  private readonly payloadValue = toSignal(this.form.controls.payload.valueChanges.pipe(map(() => this.payload())), {
    initialValue: null,
  });
  /** Status or children changed in an approval company: a supporting document is required. */
  protected readonly needsProof = computed(() => {
    const value = this.payloadValue();
    return this.mode() === 'approval' && value !== null && familyNeedsProof(this.profile().personal.family, value);
  });

  private childGroup(child?: ChildInput): ChildGroup {
    return this.fb.group({
      id: this.fb.control<string | null>(child?.id ?? null),
      firstName: this.fb.control(child?.firstName ?? '', [notBlank, Validators.maxLength(PROFILE_LIMITS.childFirstName)]),
      birthDate: this.fb.control(child?.birthDate ?? '', [Validators.required, pastDate()]),
      sex: this.fb.control<ChildSex | ''>(child?.sex ?? ''),
      dependent: this.fb.control(child?.dependent ?? true),
    });
  }

  ngOnInit(): void {
    const family = this.profile().personal.family;
    const payload = this.form.controls.payload;
    payload.controls.maritalStatus.setValue(family.maritalStatus ?? '');
    payload.controls.maritalStatusSince.setValue(family.maritalStatusSince ?? '');
    payload.controls.spouseEmployed.setValue(family.spouseEmployed ?? '');
    for (const child of family.children) payload.controls.children.push(this.childGroup(child));
  }

  protected addChild(): void {
    this.form.controls.payload.controls.children.push(this.childGroup());
  }

  protected removeChild(index: number): void {
    this.form.controls.payload.controls.children.removeAt(index);
  }

  private payload(): FamilyInput {
    const v = this.form.controls.payload.getRawValue();
    return {
      maritalStatus: v.maritalStatus || null,
      maritalStatusSince: blankToNull(v.maritalStatusSince),
      spouseEmployed: v.spouseEmployed || null,
      children: v.children.map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        firstName: c.firstName.trim(),
        birthDate: c.birthDate,
        sex: c.sex || null,
        dependent: c.dependent,
      })),
    };
  }

  protected submit(): void {
    const files = this.form.controls.files;
    if (this.needsProof() && files.value.length === 0) {
      files.setErrors({ filesRequired: true });
      files.markAsTouched();
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const payload = this.payload();
    const current = this.profile().personal.family;
    if (!familyNeedsProof(current, payload) && current.spouseEmployed === payload.spouseEmployed) {
      this.submission.formError.set({ key: 'profile.problems.unchanged' });
      return;
    }
    const approval = this.mode() === 'approval';
    const comment = blankToNull(this.form.controls.comment.value);
    this.submission.submit(
      this.form,
      { section: 'family', payload, ...(comment && approval ? { comment } : {}) },
      approval ? files.value : [],
      (r) => this.done.emit(r),
    );
  }
}
