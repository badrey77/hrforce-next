/** Small display helpers shared by the recruitment screens. */
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import type { OpeningStatus, Stage } from '../../core/recruitment/recruitment.models';

/** Opening status → one of the four global badge tones (`.badge[data-status]` in styles.css). */
export function statusTone(status: OpeningStatus): 'pending' | 'approved' | 'rejected' | 'cancelled' {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'open':
    case 'filled':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'cancelled';
  }
}

export function stageTone(stage: Stage): 'pending' | 'approved' | 'rejected' | 'cancelled' {
  if (stage === 'hired') return 'approved';
  if (stage === 'rejected') return 'rejected';
  if (stage === 'withdrawn') return 'cancelled';
  return 'pending';
}

export function loadErrorKey(error: unknown, fallback: string): string {
  if (isApiProblemError(error)) {
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 403) return 'errors.forbidden';
  }
  return fallback;
}

export function isNotFound(error: unknown): boolean {
  return isApiProblemError(error) && error.status === 404;
}

export function slugOf(error: unknown): string | undefined {
  return isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
}

/** Problem slugs of the module that are plain messages (no field), keyed to `recruitment.problems.*`. */
const PROBLEM_KEYS: Readonly<Record<string, string>> = {
  'recruitment-stage-changed': 'recruitment.problems.stageChanged',
  'recruitment-opening-not-open': 'recruitment.problems.openingNotOpen',
  'recruitment-opening-not-closed': 'recruitment.problems.openingNotClosed',
  'recruitment-opening-not-cancellable': 'recruitment.problems.notCancellable',
  'recruitment-no-post-left': 'recruitment.problems.noPostLeft',
  'recruitment-already-applied': 'recruitment.problems.alreadyApplied',
  'recruitment-application-active': 'recruitment.problems.applicationActive',
  'recruitment-file-limit': 'recruitment.problems.fileLimit',
  'forbidden-field': 'recruitment.problems.salaryForbidden',
};

/** A message key for an action that failed outside a form (move, reopen, cancel, erase, delete…). */
export function actionErrorKey(error: unknown, notFoundKey = 'recruitment.problems.gone'): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  const slug = problemSlug(error.problem.type);
  const key = slug === undefined ? undefined : PROBLEM_KEYS[slug];
  if (key) return key;
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 404) return notFoundKey;
  if (error.status === 403) return 'errors.forbidden';
  return 'errors.generic';
}

export function downloadErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'documents.file.downloadError';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 404) return 'documents.file.gone';
  if (error.status === 403) return 'errors.forbidden';
  return 'documents.file.downloadError';
}
