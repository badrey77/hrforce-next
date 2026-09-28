import { Injectable } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { StaffingService } from '../../staffing/index.js';
import { DOCUMENT_PERMISSIONS as P } from '../domain/types.js';
import { DocumentsRepository, type DocumentRow, type SignatoryRow, type TypeRow } from '../infra/documents.repository.js';
import type { DocumentEmployee, IssuedDocumentView, SignatoryView } from './document-views.js';

export const labelsOf = (t: Pick<TypeRow, 'nameFr' | 'nameAr' | 'nameEn'>) => ({ fr: t.nameFr, ar: t.nameAr, en: t.nameEn });

export function signatoryView(s: SignatoryRow, types: readonly TypeRow[]): SignatoryView {
  return {
    id: s.id,
    unit: s.orgUnitId ? { id: s.orgUnitId, code: s.unitCode ?? '', name: s.unitName ?? s.unitCode ?? '', nameAr: s.unitNameAr } : null,
    names: { fr: s.nameFr, ar: s.nameAr },
    titles: { fr: s.titleFr, ar: s.titleAr },
    active: s.active,
    defaultFor: types.filter((t) => t.defaultSignatoryId === s.id).map((t) => t.code),
  };
}

/** Builds IssuedDocumentView lists (employee cards, names, signatories, `_actions`, warnings) in a few queries. */
@Injectable()
export class DocumentPresenter {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly staffing: StaffingService,
    private readonly scopes: ScopeService,
  ) {}

  async views(companyId: string, rows: readonly DocumentRow[], options: { actions?: boolean } = {}): Promise<IssuedDocumentView[]> {
    if (rows.length === 0) return [];
    const [cards, types, names, signatories] = await Promise.all([
      this.staffing.cards(rows.map((r) => r.employmentId)),
      this.repo.types(companyId),
      this.repo.names(companyId),
      this.repo.signatories(companyId, rows[0]?.issueDate ?? '2000-01-01'),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const signatoryById = new Map(signatories.map((s) => [s.id, s]));
    const voidable = options.actions === false ? new Set<string>() : await this.scopes.unitIds(P.void);
    const ref = (id: string | null) => (id ? { id, displayName: names.get(id) ?? id } : null);
    return rows.map((r) => {
      const card = cards.get(r.employmentId);
      const employee: DocumentEmployee = card
        ? { id: card.id, matricule: card.matricule, person: card.person, unit: card.unit }
        : { id: r.employmentId, matricule: '', person: { id: '', lastName: '', firstName: '', lastNameAr: null, firstNameAr: null }, unit: { id: r.orgUnitId, code: '', kind: '', name: '', nameAr: null } };
      const type = typeById.get(r.documentTypeId);
      const signatory = signatoryById.get(r.signatoryId);
      return {
        id: r.id,
        number: r.number,
        type: { code: r.typeCode, labels: type ? labelsOf(type) : { fr: r.typeCode, ar: r.typeCode, en: r.typeCode } },
        language: r.language,
        status: r.status,
        issueDate: r.issueDate,
        issuedAt: r.issuedAt,
        issuedBy: ref(r.issuedBy),
        employee,
        leaveRequestId: r.leaveRequestId,
        documentRequestId: r.documentRequestId,
        signatory: { id: r.signatoryId, names: { fr: signatory?.nameFr ?? '', ar: signatory?.nameAr ?? '' } },
        sizeBytes: r.sizeBytes,
        sha256: r.sha256,
        void: r.status === 'void' && r.voidedAt ? { at: r.voidedAt, by: ref(r.voidedBy), reason: r.voidReason ?? '' } : null,
        warnings: r.status === 'issued' && r.leaveStatus === 'cancelled' ? ['leave-cancelled'] : [],
        _actions: r.status === 'issued' && card && voidable.has(card.unit.id) ? ['void'] : [],
      };
    });
  }
}
