/** Translation keys of refused writes on the employee panel (docs/contracts/payroll-variables.md › Endpoints). */
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';

/** A refused line write (PUT / DELETE …/lines). */
export function lineProblemKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  const { problem } = error;
  if (problemSlug(problem.type) === 'payroll-period-closed') return 'payroll.month.problems.periodClosed';
  if (problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'payroll.month.problems.amountForbidden';
  if (error.status === 404) return 'payroll.month.problems.notFound';
  if (error.status === 422) {
    const first = problem.errors?.[0];
    if (first?.field === 'rubriqueId' && first.code === 'inactive') return 'payroll.month.problems.rubriqueInactive';
    if (first?.field === 'originMonth') return 'payroll.month.problems.originInvalid';
    if (first?.field === 'employeeId') return 'payroll.month.problems.notEmployed';
    return 'payroll.month.problems.invalid';
  }
  return 'errors.generic';
}

/** A refused payroll matricule (PUT /payroll/employee-codes/:id); `field` true → shown on the input. */
export function codeProblem(error: unknown): { readonly key: string; readonly field: boolean } {
  if (!isApiProblemError(error)) return { key: 'errors.generic', field: false };
  const { problem } = error;
  if (problemSlug(problem.type) === 'payroll-matricule-taken') return { key: 'payroll.month.panel.codeTaken', field: true };
  if (error.status === 422) return { key: 'payroll.month.panel.codeInvalid', field: true };
  if (problem.type === PROBLEM_TYPE_NETWORK) return { key: 'errors.network', field: false };
  if (error.status === 403) return { key: 'errors.forbidden', field: false };
  if (error.status === 404) return { key: 'payroll.month.problems.notFound', field: false };
  return { key: 'errors.generic', field: false };
}
