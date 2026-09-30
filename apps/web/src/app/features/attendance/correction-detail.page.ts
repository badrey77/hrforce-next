/**
 * /attendance/corrections/:id — one punch correction request for HR (docs/contracts/attendance.md › Web (Phase B) ›
 * HR): who asked, for which day, why; the day BEFORE and AFTER the change (`<app-correction-preview>` over the day as
 * computed today, punches included); the approval steps with their history (`<app-workflow-stepper>`); and the
 * History (timeline `attendance_correction:<id>`: its rows, items, workflow tasks and `workflow.*` events), visible
 * to whoever may read the request.
 *
 * Angular concepts (the leave request page's, features/leave/leave-request.page.ts): route param →
 * `input.required()` (router input binding) → an `httpResource` keyed on it; a 404 reads "not found" without a retry
 * (out of scope = 404 by design, ADR 002); `@defer (on viewport; prefetch on idle)` keeps the timeline's code out of
 * this chunk until the section scrolls into view; the timeline `resolver` names the workflow step keys from the
 * request's own definition and the employee's unit, and it reads the resource's signal, so names appear as soon as
 * the request has arrived.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { isApiProblemError } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { CorrectionChanges } from '../../shared/attendance/correction-changes';
import { CorrectionPreviewView, punchesOfSummary, type PreviewSourcePunch } from '../../shared/attendance/correction-preview';
import { DayStatusBadge } from '../../shared/attendance/day-badges';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { Timeline } from '../../shared/timeline/timeline';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';

@Component({
  selector: 'app-correction-detail-page',
  imports: [
    TranslocoDirective,
    RouterLink,
    DatePipe,
    CanDirective,
    DisplayNamePipe,
    DayStatusBadge,
    CorrectionChanges,
    CorrectionPreviewView,
    WorkflowStepper,
    Timeline,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './correction-detail.page.html',
})
export class CorrectionDetailPage {
  private readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly id = input.required<string>();
  protected readonly correction = inject(AttendanceApi).correctionResource(this.id);
  protected readonly notFound = computed(() => {
    const error = this.correction.error();
    return isApiProblemError(error) && error.status === 404;
  });
  protected readonly punches = computed<readonly PreviewSourcePunch[]>(() => {
    if (!this.correction.hasValue()) return [];
    const day = this.correction.value().day;
    return day.punches ?? punchesOfSummary(day);
  });

  /** Names for the History (see header). A class field: a stable function, called inside the timeline's computed. */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    const c = this.correction.hasValue() ? this.correction.value() : undefined;
    if (!c) return undefined;
    if (kind === 'step') {
      const step = c.workflow?.steps.find((s) => s.key === value);
      return step ? this.catalog.labelOf(step.labels) : undefined;
    }
    if (kind === 'unit' && c.employee.unit.id === value) return displayNameOf(c.employee.unit, this.lang());
    return undefined;
  };
}
