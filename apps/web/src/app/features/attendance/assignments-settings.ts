/**
 * Settings › Affectations (docs/contracts/attendance.md › Settings, Schedule resolution): which schedule applies to
 * whom — the company default, sites, units (and their sub-units), single employees; the most specific wins
 * (employee > unit > ancestor unit > site > company). Current assignments grouped by kind, with "à partir du", end
 * and delete (future ones only), and a notice that the company default is changed by adding a new default from a date.
 *
 * Angular concepts:
 * - **A form whose SECOND control depends on the first**: the target kind (`company`/`site`/`unit`/`employment`)
 *   decides which picker is shown for `targetId` — a site `<select>`, the org-unit picker or the employee picker (the
 *   two shared ControlValueAccessors, chapters 07 and 15) all bound to the SAME `targetId` control. Changing the kind
 *   clears it (`valueChanges` of `kind`), so a unit id is never sent as a site id. `company` needs no target: the
 *   control's validator is switched with `setValidators()` + `updateValueAndValidity()`.
 * - **Grouping in a `computed()`** (`groups`), the list itself stays one resource; a toggle ("show ended and future")
 *   changes the resource's key (`at=all`) instead of filtering on the client, because the API decides what "current"
 *   means (valid today, Algiers).
 * - **Row actions from `_actions`** (`end`, `delete`): the server knows whether an assignment has started or is the
 *   only company default.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  algiersToday,
  ASSIGNMENT_TARGET_KINDS,
  type AssignmentTargetKind,
  type AssignmentView,
} from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { OrgApi } from '../../core/org/org-api';
import { attendanceProblemToForm } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { EmployeePicker } from '../../shared/employee-picker/employee-picker';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ASSIGNMENT_CODES, ASSIGNMENT_SLUGS } from './settings-problems';

export interface AssignmentGroup {
  readonly kind: AssignmentTargetKind;
  readonly items: readonly AssignmentView[];
}

/** Assignments grouped by target kind, in the resolution's reading order (company first). */
export function groupAssignments(items: readonly AssignmentView[]): readonly AssignmentGroup[] {
  return ASSIGNMENT_TARGET_KINDS.map((kind) => ({ kind, items: items.filter((a) => a.target.kind === kind) })).filter(
    (group) => group.items.length > 0,
  );
}

@Component({
  selector: 'app-attendance-assignments-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, RevealAlert, ControlError, OrgUnitPicker, EmployeePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assignments-settings.html',
})
export class AssignmentsSettings {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly kinds = ASSIGNMENT_TARGET_KINDS;

  protected readonly showAll = signal(false);
  protected readonly list = this.api.assignmentsResource(() => (this.showAll() ? { at: 'all' } : {}));
  protected readonly groups = computed(() => groupAssignments(this.list.hasValue() ? this.list.value().items : []));
  private readonly schedulesList = this.api.schedulesResource();
  protected readonly schedules = computed(() =>
    this.schedulesList.hasValue() ? this.schedulesList.value().items.filter((s) => s.active) : [],
  );
  private readonly canSites = inject(Session).allows('site.read');
  private readonly sitesList = inject(OrgApi).sitesResource(() => undefined, this.canSites);
  protected readonly sites = computed(() => (this.sitesList.hasValue() ? this.sitesList.value().items : []));

  protected readonly adding = signal(false);
  protected readonly ending = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    scheduleId: ['', Validators.required],
    kind: this.fb.control<AssignmentTargetKind>('unit'),
    targetId: this.fb.control<string | null>(null, Validators.required),
    validFrom: [algiersToday(), Validators.required],
  });
  protected readonly endForm = this.fb.group({ validTo: [algiersToday(), Validators.required] });

  constructor() {
    this.form.controls.kind.valueChanges.pipe(takeUntilDestroyed()).subscribe((kind) => {
      const target = this.form.controls.targetId;
      target.setValue(null);
      target.setValidators(kind === 'company' ? [] : [Validators.required]);
      target.updateValueAndValidity();
    });
  }

  protected label(labels: AssignmentView['schedule']['labels']): string {
    return pickLabel(labels, this.lang());
  }

  protected targetName(a: AssignmentView): string {
    if (a.target.kind === 'company') return '';
    return [a.target.code, a.target.name].filter(Boolean).join(' — ');
  }

  protected openAdd(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ scheduleId: this.schedules()[0]?.id ?? '', kind: 'unit', targetId: null, validFrom: algiersToday() });
    this.adding.set(true);
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api
      .createAssignment({
        scheduleId: v.scheduleId,
        target: { kind: v.kind, id: v.kind === 'company' ? null : v.targetId },
        validFrom: v.validFrom,
      })
      .subscribe({
        next: () => this.done('attendance.assignments.created'),
        error: (error: unknown) => {
          this.saving.set(false);
          this.formError.set(attendanceProblemToForm(this.form, error, ASSIGNMENT_SLUGS, ASSIGNMENT_CODES));
        },
      });
  }

  protected openEnd(a: AssignmentView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.endForm.reset({ validTo: algiersToday() });
    this.ending.set(a.id);
  }

  protected submitEnd(a: AssignmentView): void {
    if (this.endForm.invalid) {
      this.endForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.api.endAssignment(a.id, this.endForm.getRawValue().validTo).subscribe({
      next: () => this.done('attendance.assignments.ended'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(this.endForm, error, ASSIGNMENT_SLUGS));
      },
    });
  }

  protected remove(a: AssignmentView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.saving.set(true);
    this.api.deleteAssignment(a.id).subscribe({
      next: () => this.done('attendance.assignments.deleted'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(this.endForm, error, ASSIGNMENT_SLUGS));
      },
    });
  }

  private done(key: string): void {
    this.saving.set(false);
    this.adding.set(false);
    this.ending.set(null);
    this.feedback.set(key);
    this.list.reload();
    this.schedulesList.reload();
  }
}

