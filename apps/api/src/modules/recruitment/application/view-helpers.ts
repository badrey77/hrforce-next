import type { ApplicationRow, CandidateRow, FileRow } from '../infra/candidates.repository.js';
import type { CandidateFileView, NamePair, ReasonRef, UserRef } from './recruitment-views.js';

type Ref = (id: string | null) => UserRef | null;

/** A file as listed (never its hash: nothing of a candidate's files leaves through a view but the bytes on download). */
export function fileView(f: FileRow, ref: Ref, deletable: boolean): CandidateFileView {
  return {
    id: f.id,
    kind: f.kind,
    title: f.title,
    originalFilename: f.originalFilename,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    uploadedAt: f.uploadedAt.toISOString(),
    uploadedBy: ref(f.uploadedBy),
    _actions: deletable ? ['delete'] : [],
  };
}

export function namePair(c: Pick<CandidateRow, 'lastName' | 'firstName' | 'lastNameAr' | 'firstNameAr'>): NamePair {
  return { lastName: c.lastName, firstName: c.firstName, lastNameAr: c.lastNameAr, firstNameAr: c.firstNameAr };
}

/** The reason of a rejected application / transition, null otherwise. */
export function reasonRef(r: Pick<ApplicationRow, 'reasonCode' | 'reasonFr' | 'reasonAr' | 'reasonEn'>): ReasonRef | null {
  return r.reasonCode ? { code: r.reasonCode, labels: { fr: r.reasonFr ?? r.reasonCode, ar: r.reasonAr ?? r.reasonCode, en: r.reasonEn ?? r.reasonCode } } : null;
}
