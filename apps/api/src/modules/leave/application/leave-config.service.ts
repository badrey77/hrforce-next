import { Injectable, NotFoundException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { WorkflowEngine, type DefinitionView, type Labels } from '../../workflow/index.js';
import type { CountMode } from '../domain/days.js';
import { constraintViolation, LeaveRepository, type HolidayRow, type TypeRow } from '../infra/leave.repository.js';
import { LeaveClock } from './leave-clock.js';
import type { HolidayView, LeaveTypeView, PolicyView } from './leave-views.js';

export interface TypePatch {
  labels?: Labels | undefined;
  countMode?: CountMode | undefined;
  hasBalance?: boolean | undefined;
  accrualDaysPerMonth?: number | null | undefined;
  maxDaysPerYear?: number | null | undefined;
  maxDaysPerRequest?: number | null | undefined;
  oncePerCareer?: boolean | undefined;
  requiresDocument?: boolean | undefined;
  workflowDefinitionId?: string | undefined;
  active?: boolean | undefined;
  sortOrder?: number | undefined;
}

export interface HolidayInput {
  date: string;
  labels: Labels;
  approximate: boolean;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function typeView(t: TypeRow): LeaveTypeView {
  return {
    id: t.id,
    code: t.code,
    labels: { fr: t.nameFr, ar: t.nameAr, en: t.nameEn },
    countMode: t.countMode,
    hasBalance: t.hasBalance,
    accrualDaysPerMonth: num(t.accrualDaysPerMonth),
    maxDaysPerYear: num(t.maxDaysPerYear),
    maxDaysPerRequest: num(t.maxDaysPerRequest),
    oncePerCareer: t.oncePerCareer,
    requiresDocument: t.requiresDocument,
    workflowDefinitionId: t.workflowDefinitionId,
    active: t.active,
    sortOrder: t.sortOrder,
  };
}

function holidayView(h: HolidayRow): HolidayView {
  return { id: h.id, date: h.date, labels: { fr: h.nameFr, ar: h.nameAr, en: h.nameEn }, approximate: h.approximate };
}

function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw new NotFoundException();
  return companyId;
}

const invalid = (field: string, code: string, message: string) => new ValidationProblemException([{ field, code, message }]);

/**
 * Leave configuration (docs/contracts/leave.md › Endpoints): types, public holidays, policy, workflow definitions.
 * Configuration is company-wide: the route permission (leave.configure held) is the check.
 */
@Injectable()
export class LeaveConfigService {
  constructor(
    private readonly repo: LeaveRepository,
    private readonly engine: WorkflowEngine,
    private readonly clock: LeaveClock,
  ) {}

  async types(): Promise<{ items: LeaveTypeView[] }> {
    return { items: (await this.repo.types(tenant())).map(typeView) };
  }

  async updateType(id: string, patch: TypePatch): Promise<LeaveTypeView> {
    const companyId = tenant();
    const current = await this.repo.type(companyId, id);
    if (!current) throw new NotFoundException('Leave type not found');
    if (patch.workflowDefinitionId !== undefined && !(await this.repo.definitionExists(companyId, patch.workflowDefinitionId))) {
      throw invalid('workflowDefinitionId', 'not_found', 'The workflow definition does not exist.');
    }
    const hasBalance = patch.hasBalance ?? current.hasBalance;
    const accrual = patch.accrualDaysPerMonth !== undefined ? patch.accrualDaysPerMonth : num(current.accrualDaysPerMonth);
    if (accrual !== null && !hasBalance) throw invalid('accrualDaysPerMonth', 'no_balance', 'Only a type with a balance accrues days.');
    const set: Record<string, unknown> = {};
    if (patch.labels) Object.assign(set, { name_fr: patch.labels.fr, name_ar: patch.labels.ar, name_en: patch.labels.en });
    if (patch.countMode !== undefined) set['count_mode'] = patch.countMode;
    if (patch.hasBalance !== undefined) set['has_balance'] = patch.hasBalance;
    if (patch.accrualDaysPerMonth !== undefined) set['accrual_days_per_month'] = patch.accrualDaysPerMonth;
    if (patch.maxDaysPerYear !== undefined) set['max_days_per_year'] = patch.maxDaysPerYear;
    if (patch.maxDaysPerRequest !== undefined) set['max_days_per_request'] = patch.maxDaysPerRequest;
    if (patch.oncePerCareer !== undefined) set['once_per_career'] = patch.oncePerCareer;
    if (patch.requiresDocument !== undefined) set['requires_document'] = patch.requiresDocument;
    if (patch.workflowDefinitionId !== undefined) set['workflow_definition_id'] = patch.workflowDefinitionId;
    if (patch.active !== undefined) set['active'] = patch.active;
    if (patch.sortOrder !== undefined) set['sort_order'] = patch.sortOrder;
    await this.repo.updateType(companyId, id, set);
    const updated = await this.repo.type(companyId, id);
    if (!updated) throw new NotFoundException('Leave type not found');
    return typeView(updated);
  }

  async holidays(year?: number): Promise<{ year: number; items: HolidayView[] }> {
    const y = year ?? Number(this.clock.today().slice(0, 4));
    return { year: y, items: (await this.repo.holidays(tenant(), `${y}-01-01`, `${y}-12-31`)).map(holidayView) };
  }

  async createHoliday(input: HolidayInput): Promise<HolidayView> {
    const companyId = tenant();
    const id = await this.saveHoliday(() =>
      this.repo.insertHoliday(companyId, { date: input.date, nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en, approximate: input.approximate }),
    );
    return this.holiday(companyId, id);
  }

  async updateHoliday(id: string, input: HolidayInput): Promise<HolidayView> {
    const companyId = tenant();
    await this.holiday(companyId, id);
    await this.saveHoliday(() =>
      this.repo.updateHoliday(companyId, id, { date: input.date, nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en, approximate: input.approximate }),
    );
    return this.holiday(companyId, id);
  }

  async deleteHoliday(id: string): Promise<void> {
    const companyId = tenant();
    await this.holiday(companyId, id);
    await this.repo.deleteHoliday(companyId, id);
  }

  private async holiday(companyId: string, id: string): Promise<HolidayView> {
    const row = await this.repo.holiday(companyId, id);
    if (!row) throw new NotFoundException('Holiday not found');
    return holidayView(row);
  }

  private async saveHoliday<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'public_holiday_company_date_uk') {
        throw new ProblemException(409, 'holiday-date-taken', 'There is already a holiday on this date.', [
          { field: 'date', code: 'holiday_date_taken', message: 'There is already a holiday on this date.' },
        ]);
      }
      throw error;
    }
  }

  async policy(): Promise<PolicyView> {
    return this.repo.policy(tenant());
  }

  async savePolicy(input: { referenceStartMonth: number; weekendDays: number[]; entitlementDelayMonths?: number | undefined }): Promise<PolicyView> {
    const companyId = tenant();
    const current = await this.repo.policy(companyId);
    await this.repo.savePolicy(companyId, {
      referenceStartMonth: input.referenceStartMonth,
      weekendDays: input.weekendDays.toSorted((a, b) => a - b),
      entitlementDelayMonths: input.entitlementDelayMonths ?? current.entitlementDelayMonths,
    });
    return this.repo.policy(companyId);
  }

  async workflows(): Promise<{ items: DefinitionView[] }> {
    return { items: await this.engine.definitions() };
  }
}
