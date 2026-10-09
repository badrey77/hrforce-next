import type { Observable } from 'rxjs';
import type { CreateEmployee } from '../../core/employees/employees.models';
import type { HirePrefillView } from '../../core/recruitment/recruitment.models';

/**
 * What turns the create-employee form (or the rehire form) into the hire of a candidate: where its values start
 * from, where the body goes instead of `POST /employees`, and where « Annuler » leads. Everything else — fields,
 * validators, the mapping of the employee problems onto the fields — is the form's own, unchanged.
 */
export interface HireMode {
  readonly prefill: HirePrefillView;
  /** Sends the form's body (the hire endpoint adds the stage and the files to copy); answers the new employment. */
  readonly submit: (body: CreateEmployee) => Observable<{ readonly id: string }>;
  /** A failure that is not about a field of the form (the recruitment's own 409s): true when the host showed it. */
  readonly failed: (error: unknown) => boolean;
  readonly cancelLink: readonly string[];
  readonly cancelQuery: Readonly<Record<string, string>>;
}

/** `value` when it is a hire mode — an input of a routed page can also receive a query parameter (a string). */
export function asHireMode(value: unknown): HireMode | undefined {
  return typeof value === 'object' && value !== null && 'submit' in value && 'prefill' in value ? (value as HireMode) : undefined;
}
