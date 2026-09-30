/**
 * Business-rule slugs and 422 field codes of the attendance configuration endpoints → where and how the settings show
 * them (docs/contracts/attendance.md › Endpoints). Tables for `attendanceProblemToForm()`
 * (shared/attendance/attendance-forms.ts). Plain data.
 */
import type { FieldCodeTable } from '../../shared/attendance/attendance-forms';
import type { SlugTable } from '../../core/http/problem-form';

/** Every configuration write needs the permission over the WHOLE company (contract › Scope). */
const COMPANY: SlugTable = { 'forbidden-scope': { key: 'attendance.settings.companyOnly' } };

export const SCHEDULE_SLUGS: SlugTable = {
  ...COMPANY,
  'attendance-schedule-code-taken': { key: 'attendance.schedules.codeTaken', field: 'code' },
  'attendance-schedule-in-use': { key: 'attendance.schedules.inUse' },
  'attendance-version-date': { key: 'attendance.schedules.versionDate', field: 'validFrom' },
};

export const OVERRIDE_SLUGS: SlugTable = {
  ...COMPANY,
  'attendance-override-overlap': { key: 'attendance.overrides.overlap' },
};

export const OVERRIDE_CODES: FieldCodeTable = {
  'to:range_too_long': 'attendance.overrides.tooLong',
};

export const ASSIGNMENT_SLUGS: SlugTable = {
  ...COMPANY,
  'attendance-assignment-overlap': { key: 'attendance.assignments.overlap' },
  'attendance-assignment-company': { key: 'attendance.assignments.companyEnd' },
  'attendance-assignment-started': { key: 'attendance.assignments.started' },
};

/** The API names the target `target.id`; the form's control is `targetId`. */
export const ASSIGNMENT_CODES: FieldCodeTable = {
  'target.id:root_unit': { key: 'attendance.assignments.rootUnit', control: 'targetId' },
  'target.id:not_found': { key: 'attendance.assignments.targetNotFound', control: 'targetId' },
  'scheduleId:inactive': 'attendance.assignments.inactive',
};

export const KIOSK_SLUGS: SlugTable = {
  ...COMPANY,
  'kiosk-revoked': { key: 'attendance.kiosks.alreadyRevoked' },
};

export const POLICY_SLUGS: SlugTable = COMPANY;
