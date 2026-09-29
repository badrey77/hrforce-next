/**
 * Issuing rules (docs/contracts/documents.md › Issuing rules) and small pure helpers. No Nest, no Kysely.
 */
import { DocumentRuleViolation, type DocumentLanguage, type DocumentTypeCode } from './types.js';

/** The employment state a type needs on the issue date, else 409. */
export function checkEmploymentFor(type: DocumentTypeCode, employment: { endDate: string | null }, issueDate: string): void {
  if (type === 'attestation_travail' && employment.endDate !== null && employment.endDate < issueDate) {
    throw new DocumentRuleViolation('document-employment-ended', 'This employment has ended: issue a certificat de travail instead.');
  }
  if (type === 'certificat_travail' && (employment.endDate === null || employment.endDate > issueDate)) {
    throw new DocumentRuleViolation('document-employment-not-ended', 'A certificat de travail needs a recorded end date on or before today.');
  }
}

export function checkLanguage(languages: readonly string[], language: DocumentLanguage): void {
  if (!languages.includes(language)) {
    throw new DocumentRuleViolation('validation-error', 'This document type is not issued in this language.', 422, [
      { field: 'language', code: 'unsupported_language', message: `One of: ${languages.join(', ')}` },
    ]);
  }
}

export interface SignatoryCandidate {
  id: string;
  /** null = company-wide */
  orgUnitId: string | null;
  active: boolean;
}

/**
 * Signatories covering an employee, nearest first: `depth` = distance from the signatory's unit (an ancestor-or-self of
 * the employee's unit) down to it; company-wide ones last. `ancestors` maps each ancestor-or-self unit of the
 * employee's unit to its distance (0 = the unit itself).
 */
export function coveringSignatories<S extends SignatoryCandidate>(signatories: readonly S[], ancestors: ReadonlyMap<string, number>): S[] {
  const depth = (s: S) => (s.orgUnitId === null ? Number.MAX_SAFE_INTEGER : (ancestors.get(s.orgUnitId) ?? -1));
  return signatories
    .filter((s) => s.active && depth(s) >= 0)
    .toSorted((a, b) => depth(a) - depth(b) || (a.id < b.id ? -1 : 1));
}

/**
 * The signatory of a document: the one asked for (must be active and cover the employee, else 422 `signatoryId`
 * invalid_signatory); else the type's default when it covers the employee; else the nearest covering one; none →
 * 409 document-no-signatory.
 */
export function chooseSignatory<S extends SignatoryCandidate>(
  signatories: readonly S[],
  ancestors: ReadonlyMap<string, number>,
  requested: string | undefined,
  typeDefault: string | null,
): S {
  const covering = coveringSignatories(signatories, ancestors);
  if (requested) {
    const found = covering.find((s) => s.id === requested);
    if (!found) {
      throw new DocumentRuleViolation('validation-error', 'This signatory cannot sign for this employee.', 422, [
        { field: 'signatoryId', code: 'invalid_signatory', message: 'Inactive, unknown, or not covering the employee’s unit.' },
      ]);
    }
    return found;
  }
  const chosen = covering.find((s) => s.id === typeDefault) ?? covering[0];
  if (!chosen) throw new DocumentRuleViolation('document-no-signatory', 'No active signatory covers this employee: add one in the document settings.');
  return chosen;
}

/** The logo's file size cap; its type and pixel dimensions are read from the header (platform/pdf/image-header.ts). */
export const LOGO_MAX_BYTES = 256 * 1024;

/** A year's counter value → the next number's sequence (1 when the year has none yet). */
export function nextSeq(lastValue: number | null): number {
  return (lastValue ?? 0) + 1;
}
