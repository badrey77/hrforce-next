import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import { MyRecruitment, RECRUITMENT_READ } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  CONTRACT_TYPES,
  type ContractType,
  JUSTIFICATION_MAX,
  JUSTIFICATION_MIN,
  POSTS_MAX,
  POSTS_MIN,
  type RequestableUnit,
  TITLE_MAX,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { displayNameOf } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, isoDate, notBeforeDay, recruitmentProblemToForm, text, wholeNumber } from './recruitment-forms';

/** One component for `/recruitment/openings/new` (HR) and `/me/recruitment/new` (unit heads). */
@Component({
  selector: 'app-opening-request-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, OrgUnitPicker, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './opening-request.page.html',
})
export class OpeningRequestPage {
  private readonly api = inject(RecruitmentApi);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly mine = inject(MyRecruitment);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;

  /** `data: { personal: true }` on the `/me` route: back links and the landing page stay under « Mes recrutements ». */
  protected readonly personal = inject(ActivatedRoute).snapshot.data['personal'] === true;
  protected readonly backLink = this.personal ? '/me/recruitment' : '/recruitment';

  /**
   * HR searches the whole scope with the picker; a head picks among the units they head and their sub-units, which
   * the API lists (a head may not be allowed to read the org tree).
   */
  protected readonly usePicker = this.session.can(RECRUITMENT_READ) && this.session.can('org_unit.read');
  private readonly today = algiersToday();
  protected readonly myUnits = this.api.myUnitsResource(() => !this.usePicker);
  protected readonly sites = inject(OrgApi).sitesResource(() => undefined, this.session.allows('site.read'));

  protected readonly unitOptions = computed<readonly RequestableUnit[]>(() => (this.myUnits.hasValue() ? this.myUnits.value().items : []));

  protected readonly contractTypes = CONTRACT_TYPES;
  protected readonly bounds = { postsMin: POSTS_MIN, postsMax: POSTS_MAX };
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    title: ['', text(1, TITLE_MAX)],
    orgUnitId: this.fb.control<string | null>(null, Validators.required),
    siteId: [''],
    contractType: this.fb.control<ContractType>('cdi'),
    posts: [1, wholeNumber(POSTS_MIN, POSTS_MAX)],
    targetDate: ['', [Validators.required, isoDate, notBeforeDay(() => this.today)]],
    justification: ['', text(JUSTIFICATION_MIN, JUSTIFICATION_MAX)],
  });

  protected unitLabel(unit: RequestableUnit): string {
    return `${'— '.repeat(unit.depth ?? 0)}${displayNameOf(unit, this.lang())} (${unit.code})`;
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
      .requestOpening({
        title: v.title.trim(),
        orgUnitId: v.orgUnitId ?? '',
        siteId: v.siteId || null,
        contractType: v.contractType,
        posts: Number(v.posts),
        justification: v.justification.trim(),
        targetDate: v.targetDate,
      })
      .subscribe({
        next: (opening) => {
          this.mine.reload();
          // The requester always reaches the personal view; HR lands on the full page when it may read the unit.
          const target = this.personal ? ['/me/recruitment/openings', opening.id] : ['/recruitment/openings', opening.id];
          void this.router.navigate(target, { queryParams: { created: '1' } });
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.formError.set(
            recruitmentProblemToForm(this.form, error, {
              'forbidden-scope': { key: 'recruitment.errors.unitForbidden', field: 'orgUnitId' },
            }),
          );
        },
      });
  }
}
