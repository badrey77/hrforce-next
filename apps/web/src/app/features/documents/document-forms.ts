/**
 * Business-rule slugs of the Documents API → where the issue and void forms explain them (the `problemToForm()` slug
 * tables of core/http/problem-form.ts, chapter 07), plus the one problem that needs more than a sentence:
 * `document-profile-incomplete`, whose `errors[]` NAMES the missing letterhead fields. Plain TypeScript over the Forms
 * API, no DI.
 */
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, type SlugTable } from '../../core/http/problem-form';

/** Issue / preview (docs/contracts/documents.md › Issuing rules). */
export const ISSUE_SLUGS: SlugTable = {
  'document-employment-ended': { key: 'documents.problems.employmentEnded', field: 'employmentId' },
  'document-employment-not-ended': { key: 'documents.problems.employmentNotEnded', field: 'employmentId' },
  'document-leave-not-approved': { key: 'documents.problems.leaveNotApproved', field: 'leaveRequestId' },
  'document-type-inactive': { key: 'documents.problems.typeInactive', field: 'typeCode' },
  'document-no-signatory': { key: 'documents.problems.noSignatory', field: 'signatoryId' },
  'document-busy': { key: 'documents.problems.busy' },
  'document-render-failed': { key: 'documents.problems.renderFailed' },
  'document-client-request-reused': { key: 'documents.problems.clientRequestReused' },
  'document-number-taken': { key: 'documents.problems.numberTaken' },
  'forbidden-scope': { key: 'documents.problems.forbiddenScope' },
};

/** Void (`POST /documents/:id/void`). */
export const VOID_SLUGS: SlugTable = {
  'document-already-void': { key: 'documents.problems.alreadyVoid' },
  'forbidden-scope': { key: 'documents.problems.forbiddenScope' },
};

/** Letterhead fields (camelCase, as the API names them in `errors[].field`). */
export const PROFILE_FIELDS = [
  'legalNameFr',
  'legalNameAr',
  'addressFr',
  'addressAr',
  'cityFr',
  'cityAr',
  'phone',
  'email',
  'nif',
  'nis',
  'rc',
  'ai',
  'footerFr',
  'footerAr',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/**
 * The letterhead fields a `document-profile-incomplete` problem says are missing, or `null` when `error` is another
 * problem. An empty array means "incomplete" without details (older API): the page still links to the settings.
 */
export function missingProfileFields(error: unknown): readonly string[] | null {
  if (!isApiProblemError(error) || problemSlug(error.problem.type) !== 'document-profile-incomplete') return null;
  return (error.problem.errors ?? []).map((e) => e.field);
}

/** Configuration writes need `document.configure` over the WHOLE company (contract › Scope). */
export const CONFIG_SLUGS: SlugTable = {
  'forbidden-scope': { key: 'documents.problems.companyWide' },
  'document-format-taken': { key: 'documents.problems.formatTaken', field: 'numberFormat' },
};

/** 422 `errors[{field: 'file', code}]` of the logo upload → a translated sentence. */
export function logoProblem(error: unknown): FormMessage {
  if (isApiProblemError(error)) {
    const code = error.problem.errors?.find((e) => e.field === 'file')?.code;
    if (code === 'unsupported_type') return { key: 'documents.profile.logoType' };
    if (code === 'too_large') return { key: 'documents.profile.logoSize' };
    if (error.status === 403) return { key: 'documents.problems.companyWide' };
  }
  return { key: 'errors.generic' };
}
