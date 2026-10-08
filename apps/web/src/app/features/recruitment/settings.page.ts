import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type OpeningWorkflowCode,
  REASON_CODE_PATTERN,
  type ReasonView,
  RETENTION_MAX,
  RETENTION_MIN,
  WORKFLOW_CODES,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { CanDirective } from '../../shared/can/can.directive';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { CriteriaSettings } from './criteria-settings';
import { ERROR_KEYS, recruitmentProblemToForm, text, wholeNumber } from './recruitment-forms';

const LABEL_MAX = 120;
/** User reasons sort below the two automatic ones (900 / 910). */
const SORT_MAX = 899;
const KEYS = { ...ERROR_KEYS, pattern: 'recruitment.settings.reasons.codeHint' };

/** Rejection reasons: labels, order and activation. System reasons keep their code; the automatic ones are read-only. */
@Component({
  selector: 'app-recruitment-reasons-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reasons-settings.html',
  styleUrl: './recruitment.css',
})
export class ReasonsSettings {
  private readonly api = inject(RecruitmentApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;

  protected readonly list = this.api.reasonsResource();
  protected readonly items = computed<readonly ReasonView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  /** `'new'`, a reason id, or null when no form is open. */
  protected readonly editing = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = KEYS;

  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(REASON_CODE_PATTERN)]],
    fr: ['', text(1, LABEL_MAX)],
    ar: ['', text(1, LABEL_MAX)],
    en: ['', text(1, LABEL_MAX)],
    sortOrder: [0, wholeNumber(0, SORT_MAX)],
    active: [true],
  });

  protected label(reason: ReasonView): string {
    return pickLabel(reason.labels, this.lang());
  }

  protected open(reason: ReasonView | null): void {
    this.feedback.set(null);
    this.formError.set(null);
    const { code } = this.form.controls;
    if (reason) {
      this.form.reset({ code: reason.code, ...reason.labels, sortOrder: reason.sortOrder, active: reason.active });
      code.disable(); // the code is immutable
    } else {
      const next = this.items().reduce((max, r) => (r.autoOnly ? max : Math.max(max, r.sortOrder)), 0) + 10;
      this.form.reset({ code: '', fr: '', ar: '', en: '', sortOrder: Math.min(next, SORT_MAX), active: true });
      code.enable();
    }
    this.editing.set(reason?.id ?? 'new');
  }

  protected save(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const id = this.editing();
    const v = this.form.getRawValue();
    const labels = { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() };
    this.saving.set(true);
    const request$ =
      id === 'new' || id === null
        ? this.api.createReason({ code: v.code.trim(), labels })
        : this.api.updateReason(id, { labels, active: v.active, sortOrder: Number(v.sortOrder) });
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.feedback.set('recruitment.settings.saved');
        this.list.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(recruitmentProblemToForm(this.form, error));
      },
    });
  }
}

/** Retention of unsuccessful candidates' data and the approval chain of new opening requests. */
@Component({
  selector: 'app-recruitment-policy-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" aria-labelledby="rec-policy-title" data-section="policy">
      <div class="toolbar">
        <h2 id="rec-policy-title">{{ t('recruitment.settings.tab.policy') }}</h2>
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status" data-feedback>{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (policy.error()) {
        <div class="form-error" role="alert">
          <p>{{ t('recruitment.settings.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (policy.hasValue()) {
        @let c = form.controls;
        <form class="panel" [formGroup]="form" (ngSubmit)="save()" novalidate data-form="recruitment-policy">
          <div class="field">
            <label for="rec-retention">{{ t('recruitment.settings.policy.retention') }}</label>
            <input id="rec-retention" type="number" [min]="bounds.min" [max]="bounds.max" formControlName="retentionMonths"
              [attr.aria-invalid]="c.retentionMonths.invalid && c.retentionMonths.touched" aria-describedby="rec-retention-hint rec-retention-error" />
            <p class="field-hint" id="rec-retention-hint">{{ t('recruitment.settings.policy.retentionHint', bounds) }}</p>
            <app-control-error [control]="c.retentionMonths" errorId="rec-retention-error" [keys]="errorKeys" />
          </div>
          <fieldset class="field">
            <legend>{{ t('recruitment.settings.policy.workflow') }}</legend>
            @for (code of workflowCodes; track code) {
              <div class="check">
                <input type="radio" [id]="'rec-flow-' + code" formControlName="openingWorkflowCode" [value]="code" />
                <label [for]="'rec-flow-' + code">{{ t('recruitment.settings.policy.workflows.' + code.replace('recruitment.', '')) }}</label>
              </div>
            }
            <p class="field-hint">{{ t('recruitment.settings.policy.workflowHint') }}</p>
          </fieldset>
          <div class="form-actions">
            <button class="btn" type="submit" data-action="save-policy" [disabled]="saving()">{{ t('common.save') }}</button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </section>
  `,
})
export class PolicySettings {
  private readonly api = inject(RecruitmentApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly bounds = { min: RETENTION_MIN, max: RETENTION_MAX };
  protected readonly workflowCodes = WORKFLOW_CODES;
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly policy = this.api.policyResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    retentionMonths: [12, wholeNumber(RETENTION_MIN, RETENTION_MAX)],
    openingWorkflowCode: this.fb.control<OpeningWorkflowCode>('recruitment.manager_then_hr'),
  });

  constructor() {
    effect(() => {
      if (!this.policy.hasValue()) return;
      const p = this.policy.value();
      this.form.reset({ retentionMonths: p.retentionMonths, openingWorkflowCode: p.openingWorkflowCode });
    });
  }

  protected save(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api.updatePolicy({ retentionMonths: Number(v.retentionMonths), openingWorkflowCode: v.openingWorkflowCode }).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('recruitment.settings.saved');
        this.policy.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(recruitmentProblemToForm(this.form, error));
      },
    });
  }
}

export type RecruitmentSettingsTab = 'reasons' | 'criteria' | 'policy';
export const RECRUITMENT_SETTINGS_TABS: readonly RecruitmentSettingsTab[] = ['reasons', 'criteria', 'policy'];

@Component({
  selector: 'app-recruitment-settings-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, ReasonsSettings, CriteriaSettings, PolicySettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './recruitment.css',
  template: `
    <ng-container *transloco="let t">
      <p *appCan="'recruitment.read'"><a routerLink="/recruitment">{{ t('recruitment.openings.back') }}</a></p>
      <header class="page-header">
        <h1>{{ t('recruitment.settings.title') }}</h1>
      </header>
      <div class="tabs" role="tablist" [attr.aria-label]="t('recruitment.settings.title')">
        @for (name of tabs; track name) {
          <button type="button" role="tab" [id]="'rec-settings-tab-' + name" [attr.data-tab]="name" [attr.aria-selected]="active() === name"
            aria-controls="rec-settings-panel" (click)="active.set(name)">
            {{ t('recruitment.settings.tab.' + name) }}
          </button>
        }
      </div>
      <div id="rec-settings-panel" role="tabpanel" [attr.aria-labelledby]="'rec-settings-tab-' + active()">
        @switch (active()) {
          @case ('reasons') {
            <app-recruitment-reasons-settings />
          }
          @case ('criteria') {
            <app-recruitment-criteria-settings />
          }
          @case ('policy') {
            <app-recruitment-policy-settings />
          }
        }
      </div>
    </ng-container>
  `,
})
export class RecruitmentSettingsPage {
  protected readonly tabs = RECRUITMENT_SETTINGS_TABS;
  readonly tab = input<string | undefined>();
  protected readonly active = linkedSignal<string | undefined, RecruitmentSettingsTab>({
    source: this.tab,
    computation: (tab) => ((RECRUITMENT_SETTINGS_TABS as readonly string[]).includes(tab ?? '') ? (tab as RecruitmentSettingsTab) : 'reasons'),
  });
}
