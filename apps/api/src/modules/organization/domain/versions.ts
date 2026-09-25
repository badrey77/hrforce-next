/** Date-effective versions of an org unit: `[validFrom, validTo)`, `validTo` null = open-ended. Pure. */
import { OrgRuleViolation } from './org-unit.js';

export interface VersionSpan {
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface OrgUnitVersionData extends VersionSpan {
  readonly name: string;
  readonly parentId: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The local calendar date of `date` as `YYYY-MM-DD`. */
const pad = (n: number): string => String(n).padStart(2, '0');

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function covers(span: VersionSpan, date: string): boolean {
  return span.validFrom <= date && (span.validTo === null || date < span.validTo);
}

/** The version valid on `date`, if any. */
export function versionAt<T extends VersionSpan>(versions: readonly T[], date: string): T | undefined {
  return versions.find((v) => covers(v, date));
}

/** Oldest first. */
export function sortVersions<T extends VersionSpan>(versions: readonly T[]): T[] {
  return versions.toSorted((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}

export interface VersionChange {
  readonly validFrom: string;
  readonly name?: string;
  readonly parentId?: string;
}

export interface VersionPlan<T extends OrgUnitVersionData> {
  /** The current (latest) version; it is closed at `next.validFrom`. */
  readonly current: T;
  readonly next: OrgUnitVersionData;
  readonly renamed: boolean;
  readonly moved: boolean;
}

/**
 * Splits the history at `change.validFrom`: the current version — the latest, open-ended one — is closed on that
 * date and a new open-ended version carries the new name/parent (unchanged values are copied).
 * `validFrom` must be strictly after the current version's start, otherwise → org-unit-version-overlap.
 */
export function planNewVersion<T extends OrgUnitVersionData>(versions: readonly T[], change: VersionChange): VersionPlan<T> {
  const current = sortVersions(versions).at(-1);
  if (!current) throw new Error('An org unit always has at least one version');
  if (change.validFrom <= current.validFrom) {
    throw new OrgRuleViolation(
      'org-unit-version-overlap',
      `validFrom must be after ${current.validFrom}, the start of the current version.`,
      'validFrom',
    );
  }
  const name = change.name ?? current.name;
  const parentId = change.parentId ?? current.parentId;
  return {
    current,
    next: { validFrom: change.validFrom, validTo: null, name, parentId },
    renamed: name !== current.name,
    moved: parentId !== current.parentId,
  };
}
