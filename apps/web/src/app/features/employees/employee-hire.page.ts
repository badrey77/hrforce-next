import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { map } from 'rxjs';
import type { CreateEmployee } from '../../core/employees/employees.models';
import { fileBadge } from '../../core/employee-files/employee-files.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { COPY_FILES_MAX, type HirePrefillView } from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { EmployeeCreatePage } from './employee-create.page';
import type { HireMode } from './hire-mode';
import { RehireForm, type RehirePrevious } from './rehire-form';

/** The recruitment's own refusals of a hire: shown above the form, with the way back to the candidate. */
const HIRE_PROBLEMS: Readonly<Record<string, string>> = {
  'recruitment-stage-changed': 'recruitment.problems.stageChanged',
  'recruitment-opening-not-open': 'recruitment.problems.openingNotOpen',
  'recruitment-no-post-left': 'recruitment.problems.noPostLeftOffer',
  'recruitment-no-offer': 'recruitment.problems.noOffer',
  'recruitment-person-employed': 'recruitment.problems.personEmployed',
};

interface BackTarget {
  readonly link: readonly string[];
  readonly query: Readonly<Record<string, string>>;
}

function slugOf(error: unknown): string | undefined {
  return isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
}

/** The first field of a 422 that belongs to the hire, not to the employee form (`copyFileIds.<i>`, `personId`). */
function hireFieldOf(error: unknown): 'copyFileIds' | 'personId' | undefined {
  if (!isApiProblemError(error) || error.status !== 422) return undefined;
  const fields = (error.problem.errors ?? []).map((e) => e.field);
  if (fields.some((f) => f.startsWith('copyFileIds'))) return 'copyFileIds';
  // `personId` `not_found` stays the rehire form's own answer (the person left the caller's scope).
  const person = (error.problem.errors ?? []).find((e) => e.field === 'personId');
  return person && person.code !== 'not_found' ? 'personId' : undefined;
}

/**
 * /recruitment/applications/:id/hire — the hire of a candidate whose application is in `offer`. It is the
 * create-employee form (or, for a person already known, the rehire form) in hire mode: prefilled from the API's
 * hire-prefill, sent to the hire endpoint with the candidate files to copy, and landing on the new employee.
 */
@Component({
  selector: 'app-employee-hire-page',
  imports: [TranslocoDirective, RouterLink, NgTemplateOutlet, DisplayNamePipe, FileSizePipe, RevealAlert, EmployeeCreatePage, RehireForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-hire.page.html',
  styleUrl: './employees.css',
})
export class EmployeeHirePage {
  private readonly api = inject(RecruitmentApi);
  protected readonly lang = inject(LanguageService).current;

  /** `:id` of the route: the application. */
  readonly id = input.required<string>();
  /** `?candidate=<id>`: only used for « back » while the prefill (which names the candidate) is not there. */
  readonly candidate = input<string>();

  protected readonly prefill = this.api.hirePrefillResource(this.id);
  protected readonly view = computed<HirePrefillView | undefined>(() => (this.prefill.hasValue() ? this.prefill.value() : undefined));
  protected readonly badge = fileBadge;
  protected readonly maxFiles = COPY_FILES_MAX;

  /** The candidate page when its id is known, else the opening's pipeline, else the candidates list. */
  protected readonly back = computed<BackTarget>(() => {
    const candidate = this.view()?.candidateId ?? this.candidate();
    if (candidate) return { link: ['/recruitment/candidates', candidate], query: { application: this.id() } };
    const opening = this.view()?.opening;
    const none: Readonly<Record<string, string>> = {};
    return opening ? { link: ['/recruitment/openings', opening.id], query: none } : { link: ['/recruitment/candidates'], query: none };
  });

  protected readonly loadErrorKey = computed(() => {
    const error = this.prefill.error();
    if (!error) return null;
    const slug = slugOf(error);
    if (slug && HIRE_PROBLEMS[slug]) return HIRE_PROBLEMS[slug];
    if (!isApiProblemError(error)) return 'recruitment.hire.loadError';
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 404) return 'recruitment.problems.gone';
    if (error.status === 403) return 'errors.forbidden';
    return 'recruitment.hire.loadError';
  });

  // --- « Pièces à verser au dossier » ---

  protected readonly copyIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // The defaults (the CV) are ticked each time the prefill is (re)loaded.
    effect(() => {
      const view = this.view();
      if (view) this.copyIds.set(new Set(view.defaultCopyFileIds.slice(0, COPY_FILES_MAX)));
    });
  }

  protected toggleFile(id: string, checked: boolean): void {
    this.copyIds.update((ids) => {
      const next = new Set(ids);
      if (checked && next.size < COPY_FILES_MAX) next.add(id);
      if (!checked) next.delete(id);
      return next;
    });
  }

  // --- The hire itself ---

  /** A refusal of the recruitment (not of the employee form): shown above the form. */
  protected readonly hireError = signal<string | null>(null);

  protected readonly mode = computed<HireMode | undefined>(() => {
    const prefill = this.view();
    if (!prefill) return undefined;
    const back = this.back();
    return {
      prefill,
      submit: (body: CreateEmployee) => {
        this.hireError.set(null);
        // Files of the list on screen only, in its order.
        const copyFileIds = prefill.files.map((f) => f.id).filter((id) => this.copyIds().has(id));
        return this.api.hire(this.id(), { ...body, expectedStage: prefill.expectedStage, copyFileIds }).pipe(map((result) => result.employee));
      },
      failed: (error: unknown) => this.onHireFailed(error),
      cancelLink: back.link,
      cancelQuery: back.query,
    };
  });

  /** A known person: the identity is read-only and the hire is a rehire. */
  protected readonly previous = computed<RehirePrevious | undefined>(() => {
    const prefill = this.view();
    const personId = prefill?.person.personId;
    if (!prefill || !personId) return undefined;
    const latest = prefill.knownPerson?.latestEmployment;
    return { id: latest?.id ?? '', endDate: latest?.endDate ?? null, unit: { id: prefill.orgUnitId }, jobTitle: prefill.jobTitle, person: { id: personId } };
  });

  private onHireFailed(error: unknown): boolean {
    const slug = slugOf(error);
    const key = slug ? HIRE_PROBLEMS[slug] : undefined;
    if (key) {
      this.hireError.set(key);
      return true;
    }
    const field = hireFieldOf(error);
    if (!field) return false;
    // A chosen file was deleted, or the candidate was linked to / unlinked from a person meanwhile: start again
    // from what is true now.
    this.hireError.set(field === 'copyFileIds' ? 'recruitment.hire.fileGone' : 'recruitment.hire.personChanged');
    this.prefill.reload();
    return true;
  }
}
