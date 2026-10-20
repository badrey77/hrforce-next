/**
 * The employee page's **Contrats** tab (`employee.read`): the employment's contracts, newest first, with the current
 * one marked; « Nouveau contrat » (renewal / conversion / amendment), « Corriger » on the latest contract, and
 * « Ouvrir une décision » on a fixed-term latest contract (docs/contracts/contracts-deadlines.md › Web builder 1).
 * Writes need `manage_contract` in the employee's `_actions`. `<app-employee-contracts-tab [employee]="e"
 * (changed)="…" />` — `changed` lets the page re-read the header's current contract.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { ContractsApi } from '../../core/contracts/contracts-api';
import {
  CONTRACT_NOTE_MAX,
  CONTRACT_REASON_MAX,
  CONTRACT_REFERENCE_MAX,
  CONTRACT_TYPES,
  type ContractCorrection,
  type ContractKind,
  type ContractType,
  type ContractView,
  contractActions,
  isFixedTerm,
  NEW_CONTRACT_KINDS,
  type NewContract,
} from '../../core/contracts/contracts.models';
import { todayIso } from '../../core/date/iso-date';
import { type EmployeeDetail, employeeActions } from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { nextDay } from './assignment-form';
import { CONTRACT_CODE_KEYS, CONTRACT_SLUGS, DECISION_SLUGS, endDateForType, probationLimit, probationWithin } from './contract-forms';
import { employeeProblemToForm, isoDate, notBefore } from './employee-forms';
import { FieldError } from './field-error';

type NewKind = ContractKind;
type Editing = 'new' | 'correct' | null;

function orUndefined(value: string): string | undefined {
  return value.trim() || undefined;
}

function orNull(value: string): string | null {
  return value.trim() || null;
}

/**
 * Defaults of a new contract after `latest`: a renewal and a conversion start the day after it ends; the initial
 * contract (an employment recorded without one, e.g. before contracts existed) starts on the hire date.
 */
export function newContractDefaults(
  kind: NewKind,
  latest: ContractView | undefined,
  today: string,
  hireDate = today,
): { contractType: ContractType | ''; startDate: string } {
  if (kind === 'initial') return { contractType: '', startDate: hireDate };
  const after = latest?.endDate ? nextDay(latest.endDate) : today;
  if (kind === 'renewal') return { contractType: latest && isFixedTerm(latest.contractType) ? latest.contractType : 'cdd', startDate: after };
  // A conversion is usually to a CDI; after a CDI the new type is left to choose.
  if (kind === 'conversion') return { contractType: latest?.contractType === 'cdi' ? '' : 'cdi', startDate: after };
  return { contractType: latest?.contractType ?? '', startDate: today };
}

@Component({
  selector: 'app-employee-contracts-tab',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, FieldError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-contracts-tab.html',
  styleUrl: './employees.css',
})
export class EmployeeContractsTab {
  private readonly api = inject(ContractsApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly canDeadlines = inject(Session).allows('deadline.read');

  readonly employee = input.required<EmployeeDetail>();
  /** A contract was added or corrected, or a decision opened: the page re-reads the employee. */
  readonly changed = output<void>();

  /** The list is keyed on the id only: a reload of the employee (a new object) must not read the contracts again. */
  private readonly employmentId = computed(() => this.employee().id);
  protected readonly list = this.api.listResource(this.employmentId);
  protected readonly items = computed<readonly ContractView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  /** Newest first: the latest contract is the first one. */
  protected readonly latest = computed<ContractView | undefined>(() => this.items()[0]);
  protected readonly canManage = computed(() => employeeActions(this.employee()).includes('manage_contract'));
  protected readonly loadErrorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    return 'contracts.tab.loadError';
  });

  protected readonly editing = signal<Editing>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  /** Without any contract only the initial one can be recorded; a CDI (no end) cannot be renewed. */
  protected readonly kinds = computed<readonly NewKind[]>(() => {
    const latest = this.latest();
    if (!latest) return ['initial'];
    return isFixedTerm(latest.contractType) ? NEW_CONTRACT_KINDS : NEW_CONTRACT_KINDS.filter((k) => k !== 'renewal');
  });
  protected readonly types = CONTRACT_TYPES;
  protected readonly referenceMax = CONTRACT_REFERENCE_MAX;
  protected readonly reasonMax = CONTRACT_REASON_MAX;
  protected readonly noteMax = CONTRACT_NOTE_MAX;
  protected readonly fixedTerm = isFixedTerm;

  // --- New contract -------------------------------------------------------------------------------------------

  protected readonly newForm = this.fb.group({
    kind: this.fb.control<NewKind>('renewal', Validators.required),
    contractType: this.fb.control<ContractType | ''>('', Validators.required),
    startDate: ['', [Validators.required, isoDate]],
    endDate: ['', [isoDate, endDateForType, notBefore(() => this.newStart())]],
    probationEnd: ['', [isoDate, notBefore(() => this.newStart()), probationWithin(() => this.newStart())]],
    reference: ['', Validators.maxLength(CONTRACT_REFERENCE_MAX)],
    reason: ['', Validators.maxLength(CONTRACT_REASON_MAX)],
    note: ['', Validators.maxLength(CONTRACT_NOTE_MAX)],
  });
  protected readonly newType = signal<ContractType | ''>('');
  protected readonly newStartValue = signal('');
  protected readonly probationMax = computed(() => (this.newStartValue() ? probationLimit(this.newStartValue()) : ''));

  private newStart(): string | null {
    // The validators run once while the form is being built, before `newForm` is assigned.
    return (this.newForm as typeof this.newForm | undefined)?.controls.startDate.value || null;
  }

  constructor() {
    const c = this.newForm.controls;
    c.kind.valueChanges.subscribe((kind) => this.applyDefaults(kind));
    c.contractType.valueChanges.subscribe((type) => {
      this.newType.set(type);
      if (!isFixedTerm(type) && c.endDate.value) c.endDate.setValue('');
      c.endDate.updateValueAndValidity();
    });
    c.startDate.valueChanges.subscribe((start) => {
      this.newStartValue.set(start);
      c.endDate.updateValueAndValidity();
      c.probationEnd.updateValueAndValidity();
    });
    // The probation ends within the contract: re-check it when the end date moves.
    c.endDate.valueChanges.subscribe(() => c.probationEnd.updateValueAndValidity({ emitEvent: false }));
    const k = this.correctForm.controls;
    k.endDate.valueChanges.subscribe(() => k.probationEnd.updateValueAndValidity({ emitEvent: false }));
  }

  private applyDefaults(kind: NewKind): void {
    const defaults = newContractDefaults(kind, this.latest(), todayIso(), this.employee().hireDate);
    this.newForm.patchValue({ contractType: defaults.contractType, startDate: defaults.startDate });
  }

  protected openNew(): void {
    this.feedback.set(null);
    this.formError.set(null);
    const kind = this.kinds()[0] ?? 'renewal';
    this.newForm.reset({ kind, contractType: '', startDate: '', endDate: '', probationEnd: '', reference: '', reason: '', note: '' });
    this.applyDefaults(kind);
    this.editing.set('new');
  }

  protected submitNew(): void {
    this.formError.set(null);
    if (this.newForm.invalid) {
      this.newForm.markAllAsTouched();
      this.formError.set({ key: 'employees.create.fixErrors' });
      return;
    }
    const v = this.newForm.getRawValue();
    if (v.contractType === '') return;
    const body: { -readonly [K in keyof NewContract]: NewContract[K] } = { kind: v.kind, contractType: v.contractType, startDate: v.startDate };
    if (isFixedTerm(v.contractType) && v.endDate) body.endDate = v.endDate;
    if (v.probationEnd) body.probationEnd = v.probationEnd;
    const reference = orUndefined(v.reference);
    if (reference) body.reference = reference;
    const reason = orUndefined(v.reason);
    if (reason) body.reason = reason;
    const note = orUndefined(v.note);
    if (note) body.note = note;
    this.submitting.set(true);
    this.api.create(this.employee().id, body).subscribe({
      next: () => this.saved('contracts.feedback.created'),
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.newForm, error, CONTRACT_SLUGS, {}, undefined, CONTRACT_CODE_KEYS));
        this.submitting.set(false);
      },
    });
  }

  // --- Correct the latest contract ------------------------------------------------------------------------------

  protected readonly correctForm = this.fb.group({
    endDate: ['', [isoDate, notBefore(() => this.latest()?.startDate ?? null)]],
    probationEnd: ['', [isoDate, notBefore(() => this.latest()?.startDate ?? null), probationWithin(() => this.latest()?.startDate ?? null)]],
    reference: ['', Validators.maxLength(CONTRACT_REFERENCE_MAX)],
    reason: ['', Validators.maxLength(CONTRACT_REASON_MAX)],
    note: ['', Validators.maxLength(CONTRACT_NOTE_MAX)],
  });

  protected openCorrect(): void {
    const latest = this.latest();
    if (!latest) return;
    this.feedback.set(null);
    this.formError.set(null);
    this.correctForm.reset({
      endDate: latest.endDate ?? '',
      probationEnd: latest.probationEnd ?? '',
      reference: latest.reference ?? '',
      reason: latest.reason ?? '',
      note: latest.note ?? '',
    });
    const { endDate } = this.correctForm.controls;
    endDate.setValidators(isFixedTerm(latest.contractType) ? [Validators.required, isoDate, notBefore(() => latest.startDate)] : []);
    endDate.updateValueAndValidity();
    this.editing.set('correct');
  }

  protected submitCorrect(): void {
    const latest = this.latest();
    this.formError.set(null);
    if (!latest) return;
    if (this.correctForm.invalid) {
      this.correctForm.markAllAsTouched();
      this.formError.set({ key: 'employees.create.fixErrors' });
      return;
    }
    const v = this.correctForm.getRawValue();
    const next: ContractCorrection = {
      ...(isFixedTerm(latest.contractType) ? { endDate: v.endDate || null } : {}),
      probationEnd: v.probationEnd || null,
      reference: orNull(v.reference),
      reason: orNull(v.reason),
      note: orNull(v.note),
    };
    // Only what changed is sent.
    const body = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => (latest[key as keyof ContractCorrection] ?? null) !== value),
    ) as ContractCorrection;
    if (Object.keys(body).length === 0) {
      this.formError.set({ key: 'employees.form.errors.nothingChanged' });
      return;
    }
    this.submitting.set(true);
    this.api.correct(this.employee().id, latest.id, body).subscribe({
      next: () => this.saved('contracts.feedback.corrected'),
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.correctForm, error, CONTRACT_SLUGS, {}, undefined, CONTRACT_CODE_KEYS));
        this.submitting.set(false);
      },
    });
  }

  // --- Contract decision ----------------------------------------------------------------------------------------

  protected readonly decisionError = signal<FormMessage | null>(null);
  protected readonly decisionSubmitting = signal(false);

  /** HR may open a decision on the latest contract when it is fixed-term and none is pending. */
  protected readonly canOpenDecision = computed(() => {
    const latest = this.latest();
    return this.canManage() && !!latest && isFixedTerm(latest.contractType) && !latest.pendingDecision && this.employee().status !== 'ended';
  });

  protected openDecision(): void {
    const latest = this.latest();
    if (!latest) return;
    this.feedback.set(null);
    this.decisionError.set(null);
    this.decisionSubmitting.set(true);
    this.api.openDecision(this.employee().id, latest.id).subscribe({
      next: () => {
        this.decisionSubmitting.set(false);
        this.feedback.set('contracts.feedback.decisionOpened');
        this.list.reload();
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.decisionSubmitting.set(false);
        this.decisionError.set(employeeProblemToForm(this.newForm, error, DECISION_SLUGS));
        this.list.reload();
      },
    });
  }

  protected cancel(): void {
    this.editing.set(null);
    this.formError.set(null);
  }

  protected canEdit(contract: ContractView): boolean {
    return this.canManage() && contractActions(contract).includes('edit');
  }

  private saved(key: string): void {
    this.submitting.set(false);
    this.editing.set(null);
    this.feedback.set(key);
    this.list.reload();
    this.changed.emit();
  }
}
