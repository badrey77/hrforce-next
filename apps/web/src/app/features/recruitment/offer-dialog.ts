import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import type { UnitRef } from '../../core/employees/employees.models';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type ApplicationDetailView,
  CONTRACT_TYPES,
  type ContractType,
  OFFER_NOTE_MAX,
  type OfferInput,
  type OfferView,
  type OpeningView,
  type Stage,
  TITLE_MAX,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { displayNameOf } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, isoDate, money, normaliseMoney, recruitmentProblemToForm, text } from './recruitment-forms';
import { actionErrorKey, isStale } from './recruitment-view';
import type { MoveFailure } from './stage-move';
import { type UnitOption, unitsWithSubUnits } from './unit-options';

export interface OfferSubject {
  readonly applicationId: string;
  /** The stage on screen, sent as `expectedStage`. */
  readonly stage: Stage;
  readonly name: string;
  readonly openingId: string;
  /** The opening, when the host already has it (the board); fetched otherwise. */
  readonly opening?: OpeningView;
}

export interface OfferOutcome {
  readonly application: ApplicationDetailView;
  readonly kind: 'made' | 'updated';
  readonly name: string;
}

interface Pending {
  readonly subject: OfferSubject;
  /** The offer being edited, with the proposed salary the caller can see; null when making one. */
  readonly editing: { readonly offer: OfferView; readonly proposed: string | null } | null;
}

/** Offer-specific wording of answers the module words otherwise. */
export const OFFER_SLUGS = {
  'recruitment-no-post-left': { key: 'recruitment.problems.noPostLeftOffer' },
  'forbidden-field': { key: 'recruitment.problems.proposedSalaryForbidden', field: 'proposedSalary' },
  'forbidden-scope': { key: 'errors.forbidden' },
} as const;

/** Records or edits the offer of one application (the candidate page and the board share it). */
@Component({
  selector: 'app-offer-dialog',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './offer-dialog.html',
})
export class OfferDialog {
  private readonly api = inject(RecruitmentApi);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;

  readonly saved = output<OfferOutcome>();
  readonly failed = output<MoveFailure>();

  readonly busy = signal(false);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly opening = signal<OpeningView | null>(null);
  protected readonly openingError = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly contractTypes = CONTRACT_TYPES;
  protected readonly canSalary = this.session.allows('recruitment.salary.update');
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  // The unit of the offer is the opening's unit or one of its sub-units: listed from the tree when it is readable.
  private readonly wanted = signal(false);
  private readonly today = algiersToday();
  private readonly tree = inject(OrgApi).treeResource(() => (this.wanted() && this.session.can('org_unit.read') ? this.today : undefined));
  protected readonly sites = inject(OrgApi).sitesResource(() => undefined, () => this.wanted() && this.session.can('site.read'));
  protected readonly units = computed<readonly UnitOption[]>(() => {
    const opening = this.opening();
    if (!opening) return [];
    const options = unitsWithSubUnits([opening.unit], this.tree.hasValue() ? this.tree.value().root : undefined);
    const current = this.pending()?.editing?.offer.unit;
    return current && !options.some((o) => o.id === current.id) ? [...options, toOption(current)] : options;
  });

  protected readonly form = this.fb.group({
    jobTitle: ['', text(1, TITLE_MAX)],
    orgUnitId: ['', Validators.required],
    siteId: [''],
    contractType: this.fb.control<ContractType>('cdi'),
    startDate: ['', [Validators.required, isoDate]],
    note: ['', text(1, OFFER_NOTE_MAX, false)],
    proposedSalary: ['', money],
  });

  protected unitLabel(unit: UnitOption): string {
    return `${'— '.repeat(unit.depth)}${displayNameOf(unit, this.lang())} (${unit.code})`;
  }

  make(subject: OfferSubject): void {
    this.show({ subject, editing: null });
  }

  edit(subject: OfferSubject, offer: OfferView, proposed: string | null): void {
    this.show({ subject, editing: { offer, proposed } });
  }

  private show(pending: Pending): void {
    this.formError.set(null);
    this.openingError.set(false);
    this.wanted.set(true);
    this.pending.set(pending);
    this.opening.set(null);
    this.form.reset();
    this.dialog().nativeElement.showModal();
    const { opening, openingId } = pending.subject;
    if (opening) {
      this.fill(opening, pending);
      return;
    }
    this.api.opening(openingId).subscribe({
      next: (loaded) => {
        if (this.pending() === pending) this.fill(loaded, pending);
      },
      error: () => this.openingError.set(true),
    });
  }

  /** A new offer starts from the opening (title, unit, site, contract); an edit from the offer itself. */
  private fill(opening: OpeningView, pending: Pending): void {
    this.opening.set(opening);
    const offer = pending.editing?.offer;
    this.form.reset(
      offer
        ? {
            jobTitle: offer.jobTitle,
            orgUnitId: offer.unit.id,
            siteId: offer.site?.id ?? '',
            contractType: offer.contractType,
            startDate: offer.startDate,
            note: offer.note ?? '',
            proposedSalary: pending.editing?.proposed ?? '',
          }
        : {
            jobTitle: opening.title,
            orgUnitId: opening.unit.id,
            siteId: opening.siteInherited ? '' : (opening.site?.id ?? ''),
            contractType: opening.contractType,
            startDate: '',
            note: '',
            proposedSalary: '',
          },
    );
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected save(): void {
    const p = this.pending();
    if (!p) return;
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const note = v.note.trim();
    const salary = v.proposedSalary.trim() ? normaliseMoney(v.proposedSalary) : null;
    const body: { -readonly [K in keyof OfferInput]: OfferInput[K] } = {
      jobTitle: v.jobTitle.trim(),
      orgUnitId: v.orgUnitId,
      siteId: v.siteId || null,
      contractType: v.contractType,
      startDate: v.startDate,
      note: note || null,
    };
    // The salary is only sent by someone allowed to write it; an edit says so when it was emptied.
    if (this.canSalary()) {
      if (salary) body.proposedSalary = salary;
      else if (p.editing?.proposed) body.proposedSalary = null;
    }
    const request$: Observable<ApplicationDetailView> = p.editing
      ? this.api.updateOffer(p.subject.applicationId, body)
      : this.api.makeOffer(p.subject.applicationId, { ...body, expectedStage: p.subject.stage });
    this.busy.set(true);
    request$.subscribe({
      next: (application) => {
        this.busy.set(false);
        this.close();
        this.saved.emit({ application, kind: p.editing ? 'updated' : 'made', name: p.subject.name });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        if (isStale(error)) {
          this.close();
          this.failed.emit({ key: actionErrorKey(error), reload: true });
          return;
        }
        this.formError.set(recruitmentProblemToForm(this.form, error, OFFER_SLUGS));
      },
    });
  }
}

function toOption(unit: UnitRef): UnitOption {
  return { id: unit.id, code: unit.code, name: unit.name, nameAr: unit.nameAr, depth: 0 };
}
