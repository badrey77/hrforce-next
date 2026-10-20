import type { DocumentTypeView, TemplateVersionView, TypeTemplates } from '../app/core/documents/documents.models';
import type { TemplateField, TemplateLayout, TemplateVariable } from '../lib/document-designer';
import { TYPE_ATT } from './document-fixtures';

/** Shapes of docs/contracts/document-templates.md (the DEMO seed's « Ordre de mission »). */
export const FIELD_DESTINATION: TemplateField = { key: 'destination', kind: 'text', labels: { fr: 'Destination', ar: 'الوجهة' }, required: true };
export const FIELD_TRANSPORT: TemplateField = {
  key: 'transport',
  kind: 'choice',
  labels: { fr: 'Moyen de transport', ar: 'وسيلة النقل' },
  required: false,
  options: [
    { value: 'vehicule', labels: { fr: 'Véhicule de service', ar: 'سيارة المصلحة' } },
    { value: 'avion', labels: { fr: 'Avion', ar: 'الطائرة' } },
  ],
};
export const FIELD_DEPART: TemplateField = { key: 'depart', kind: 'date', labels: { fr: 'Date de départ', ar: 'تاريخ الذهاب' }, required: true };

export const TYPE_OM: DocumentTypeView = {
  ...TYPE_ATT,
  id: 'dt-om',
  code: 'ordre_mission',
  labels: { fr: 'Ordre de mission', ar: 'أمر بمهمة', en: 'Mission order' },
  selfService: false,
  sortOrder: 40,
  numberFormat: 'OM-{YYYY}-{SEQ:4}',
  nextNumber: 'OM-2026-0001',
  kind: 'custom',
  subject: 'employment',
  employmentRule: 'active',
  templateMode: 'designed',
  template: { id: 'tv-om-1', version: 1, fields: [FIELD_DESTINATION, FIELD_TRANSPORT, FIELD_DEPART] },
};

export const TYPE_ATT_DESIGNED: DocumentTypeView = {
  ...TYPE_ATT,
  kind: 'system',
  subject: 'employment',
  employmentRule: 'active',
  templateMode: 'designed',
  template: { id: 'tv-att-1', version: 1, fields: [] },
};

export const LAYOUT_FR: TemplateLayout = {
  v: 1,
  page: { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' },
  blocks: [
    { id: 't1', type: 'title', align: 'center', content: [{ t: 'text', text: 'ORDRE DE MISSION' }] },
    { id: 'p1', type: 'paragraph', align: 'justify', content: [{ t: 'var', key: 'employee.fullName' }, { t: 'text', text: ' se rendra à ' }, { t: 'var', key: 'field.destination' }] },
    { id: 's1', type: 'signature', align: 'end' },
  ],
};

export const VARIABLES: readonly TemplateVariable[] = [
  { key: 'employee.fullName', labels: { fr: 'nom', ar: 'الاسم', en: 'name' }, group: 'employee', sample: { fr: 'Amine Benali', ar: 'أمين بن علي' } },
  { key: 'document.number', labels: { fr: 'numéro', ar: 'الرقم', en: 'number' }, group: 'document', sample: { fr: 'OM-2026-…', ar: 'OM-2026-…' } },
];

export function templateVersion(extra: Partial<TemplateVersionView> = {}): TemplateVersionView {
  return {
    id: 'tv-om-2',
    version: 2,
    status: 'draft',
    languages: ['fr'],
    fieldCount: 1,
    note: null,
    updatedAt: '2026-10-09T10:00:00Z',
    updatedBy: { id: 'u-admin', displayName: 'Amina Benali' },
    publishedAt: null,
    publishedBy: null,
    issuedCount: 0,
    typeId: 'dt-om',
    typeCode: 'ordre_mission',
    layouts: { fr: LAYOUT_FR },
    fields: [FIELD_DESTINATION],
    revision: 4,
    basedOn: 'tv-om-1',
    _actions: ['edit', 'publish', 'discard'],
    ...extra,
  };
}

export function typeTemplates(extra: Partial<TypeTemplates> = {}): TypeTemplates {
  const draft = templateVersion();
  const published = templateVersion({ id: 'tv-om-1', version: 1, status: 'published', publishedAt: '2026-10-01T08:00:00Z', issuedCount: 3, _actions: ['duplicate'] });
  return {
    mode: 'designed',
    builtin: null,
    items: [
      { ...summary(draft) },
      { ...summary(published) },
    ],
    ...extra,
  };
}

function summary(v: TemplateVersionView) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    languages: v.languages,
    fieldCount: v.fieldCount,
    note: v.note,
    updatedAt: v.updatedAt,
    updatedBy: v.updatedBy,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    issuedCount: v.issuedCount,
  };
}
