/**
 * `<app-workflow-stepper [progress]="request.workflow" [history]="request.history" />` — where an approval stands:
 * "Manager ✓ → Regional HR (waiting) → …", step labels from the workflow DEFINITION in the UI language.
 *
 * Angular concepts:
 * - **Presentational component + a pure function.** The rules ("which step is done, current, rejected?") live in
 *   `stepStates()`, plain TypeScript tested without TestBed; the component only maps states to markup. A
 *   `computed()` calls it, so the states are recomputed only when `progress` or `history` change — not on every
 *   change-detection pass, as a method called from the template would be.
 * - **Labels are data** (`workflow_definition.steps[].labels`, written by the business): picked in the active
 *   language by `LeaveCatalog.labelOf()`, which reads the language signal — the stepper re-labels on a language switch.
 *   The STATE words ("done", "waiting", "rejected") are UI text, so they come from Transloco.
 * - **Accessibility**: an ordered list (`<ol>`: order matters), `aria-current="step"` on the open step (the ARIA value
 *   made for steppers), and each state spelled out as text under the step name — colour and ticks alone are not
 *   enough (the dot is `aria-hidden`).
 * - **RTL for free**: the steps are flex items laid out along the INLINE axis, and the connector line is drawn with
 *   `inset-inline-start`/`border-block-start`. In Arabic (`dir="rtl"`) the first step is on the right and the line
 *   runs right-to-left without a single `[dir=rtl]` rule. The tick "✓" is direction-neutral; no arrow glyph is used
 *   (an arrow would need mirroring).
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { WorkflowProgress, WorkflowStepDef, WorkflowTaskHistory } from '../../core/leave/leave.models';

export type StepState = 'done' | 'current' | 'rejected' | 'cancelled' | 'upcoming' | 'skipped';

export interface StepView {
  readonly step: WorkflowStepDef;
  readonly state: StepState;
  readonly escalated: boolean;
}

/**
 * The state of each step. `currentStep` is the open step while `pending`; once finished the API may send `null`, so
 * the step where the instance stopped is taken from the history (the task with outcome `reject`, or the cancelled one).
 */
export function stepStates(progress: WorkflowProgress, history: readonly WorkflowTaskHistory[] = []): StepView[] {
  const escalated = new Set(history.filter((task) => task.outcome === 'escalated').map((task) => task.stepIndex));
  const stoppedAt = (predicate: (task: WorkflowTaskHistory) => boolean): number =>
    history.find(predicate)?.stepIndex ?? progress.currentStep ?? -1;

  return progress.steps.map((step, index) => {
    let state: StepState;
    switch (progress.status) {
      case 'approved':
        state = history.some((t) => t.stepIndex === index && t.status === 'skipped') ? 'skipped' : 'done';
        break;
      case 'pending': {
        const current = progress.currentStep ?? 0;
        state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
        break;
      }
      case 'rejected': {
        const at = stoppedAt((t) => t.outcome === 'reject');
        state = at < 0 ? 'upcoming' : index < at ? 'done' : index === at ? 'rejected' : 'upcoming';
        break;
      }
      case 'cancelled': {
        const at = stoppedAt((t) => t.status === 'cancelled');
        // Cancelled after approval (a future leave): every step had been approved.
        state = at < 0 ? 'done' : index < at ? 'done' : index === at ? 'cancelled' : 'upcoming';
        break;
      }
    }
    return { step, state, escalated: escalated.has(index) };
  });
}

@Component({
  selector: 'app-workflow-stepper',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="stepper" *transloco="let t" [attr.aria-label]="t('workflow.stepper.label')">
      @for (view of views(); track view.step.key; let i = $index) {
        <li [attr.data-state]="view.state" [attr.aria-current]="view.state === 'current' ? 'step' : null">
          <span class="dot" aria-hidden="true">{{ view.state === 'done' ? '✓' : view.state === 'rejected' || view.state === 'cancelled' ? '✕' : i + 1 }}</span>
          <span class="text">
            <span class="name">{{ catalog.labelOf(view.step.labels) }}</span>
            <span class="state">{{ t('workflow.state.' + view.state) }}</span>
            @if (view.escalated) {
              <span class="state">{{ t('workflow.escalated') }}</span>
            }
          </span>
        </li>
      }
    </ol>
  `,
  styleUrl: './workflow-stepper.css',
})
export class WorkflowStepper {
  protected readonly catalog = inject(LeaveCatalog);

  readonly progress = input.required<WorkflowProgress>();
  readonly history = input<readonly WorkflowTaskHistory[]>([]);

  protected readonly views = computed(() => stepStates(this.progress(), this.history()));
}
