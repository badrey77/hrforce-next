/**
 * The placeholders of designed templates (docs/contracts/document-templates.md › Variables): a fixed catalogue, keyed by
 * dotted names. Every value is a string the API has already formatted in the document's language (the snapshot rules
 * of documents.md); null = unknown, printed as nothing. Deliberately absent (assumption 5): salary, RIB, NSS, NIN,
 * medical data, the employee's address and phone. Pure: no Nest, no Kysely.
 */
import { daysPhrase, type DocumentSnapshot, type EmployeeFacts, type ProfileFacts } from './snapshot.js';
import type { DocumentLanguage, DocumentSubject } from './types.js';

export type VariableGroup = 'document' | 'company' | 'employee' | 'leave' | 'signatory';

export interface TemplateVariable {
  key: string;
  /** the chip name in the designer, e.g. nom / الاسم / name */
  labels: { fr: string; ar: string; en: string };
  group: VariableGroup;
  subjects: readonly DocumentSubject[];
  sample: { fr: string; ar: string };
}

const BOTH: readonly DocumentSubject[] = ['employment', 'leave_request'];
const LEAVE: readonly DocumentSubject[] = ['leave_request'];

const v = (key: string, group: VariableGroup, labels: [string, string, string], sample: [string, string], subjects = BOTH): TemplateVariable => ({
  key,
  labels: { fr: labels[0], ar: labels[1], en: labels[2] },
  group,
  subjects,
  sample: { fr: sample[0], ar: sample[1] },
});

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  v('document.number', 'document', ['numéro', 'رقم الوثيقة', 'number'], ['OM-2026-0042', 'OM-2026-0042']),
  v('document.issueDate', 'document', ['date du document', 'تاريخ الوثيقة', 'document date'], ['9 octobre 2026', '9 أكتوبر 2026']),
  v('document.city', 'document', ['fait à', 'حرر في', 'place'], ['Alger', 'الجزائر']),
  v('company.legalName', 'company', ['raison sociale', 'اسم المؤسسة', 'company name'], ['Entreprise Démo', 'مؤسسة تجريبية']),
  v('company.address', 'company', ['adresse de l’entreprise', 'عنوان المؤسسة', 'company address'], ['12 rue Didouche Mourad, Alger', '12 شارع ديدوش مراد، الجزائر']),
  v('company.phone', 'company', ['téléphone', 'الهاتف', 'phone'], ['+213 21 00 00 00', '+213 21 00 00 00']),
  v('company.email', 'company', ['e-mail', 'البريد الإلكتروني', 'e-mail'], ['rh@exemple.dz', 'rh@exemple.dz']),
  v('company.nif', 'company', ['NIF', 'رقم التعريف الجبائي', 'tax id (NIF)'], ['000016000000000', '000016000000000']),
  v('company.nis', 'company', ['NIS', 'رقم التعريف الإحصائي', 'statistical id (NIS)'], ['000016000000000', '000016000000000']),
  v('company.rc', 'company', ['RC', 'السجل التجاري', 'trade register (RC)'], ['16/00-0000000 B 26', '16/00-0000000 B 26']),
  v('company.ai', 'company', ['article d’imposition', 'رقم المادة الجبائية', 'tax article'], ['16000000000', '16000000000']),
  v('employee.civility', 'employee', ['civilité', 'السيد(ة)', 'title'], ['M.', 'السيد']),
  v('employee.fullName', 'employee', ['nom', 'الاسم', 'name'], ['Amine Benali', 'أمين بن علي']),
  v('employee.firstName', 'employee', ['prénom', 'الاسم الأول', 'first name'], ['Amine', 'أمين']),
  v('employee.lastName', 'employee', ['nom de famille', 'اللقب', 'last name'], ['Benali', 'بن علي']),
  v('employee.matricule', 'employee', ['matricule', 'رقم التسجيل', 'employee number'], ['EMP-0042', 'EMP-0042']),
  v('employee.birthDate', 'employee', ['date de naissance', 'تاريخ الميلاد', 'birth date'], ['14 mars 1988', '14 مارس 1988']),
  v('employee.birthPlace', 'employee', ['lieu de naissance', 'مكان الميلاد', 'birth place'], ['Annaba', 'عنابة']),
  v('employee.jobTitle', 'employee', ['fonction', 'الوظيفة', 'job title'], ['Chargé de clientèle', 'Chargé de clientèle']),
  v('employee.unit', 'employee', ['structure', 'الهيكل', 'unit'], ['Agence Annaba', 'وكالة عنابة']),
  v('employee.hireDate', 'employee', ['date d’embauche', 'تاريخ التوظيف', 'hire date'], ['1er septembre 2019', '1 سبتمبر 2019']),
  v('employee.endDate', 'employee', ['date de fin', 'تاريخ نهاية العمل', 'end date'], ['30 juin 2026', '30 جوان 2026']),
  v('leave.type', 'leave', ['type de congé', 'نوع العطلة', 'leave type'], ['Congé annuel', 'عطلة سنوية'], LEAVE),
  v('leave.start', 'leave', ['début du congé', 'بداية العطلة', 'leave start'], ['12 octobre 2026', '12 أكتوبر 2026'], LEAVE),
  v('leave.end', 'leave', ['fin du congé', 'نهاية العطلة', 'leave end'], ['26 octobre 2026', '26 أكتوبر 2026'], LEAVE),
  v('leave.days', 'leave', ['nombre de jours', 'عدد الأيام', 'number of days'], ['15', '15'], LEAVE),
  v('leave.daysText', 'leave', ['durée du congé', 'مدة العطلة', 'leave duration'], ['15 jours', '15 يومًا'], LEAVE),
  v('leave.resumption', 'leave', ['date de reprise', 'تاريخ استئناف العمل', 'return date'], ['27 octobre 2026', '27 أكتوبر 2026'], LEAVE),
  v('signatory.name', 'signatory', ['signataire', 'اسم الموقع', 'signatory'], ['Farid Belkacem', 'فريد بلقاسم']),
  v('signatory.title', 'signatory', ['titre du signataire', 'صفة الموقع', 'signatory title'], ['Directeur des ressources humaines', 'مدير الموارد البشرية']),
];

const BY_KEY = new Map(TEMPLATE_VARIABLES.map((variable) => [variable.key, variable]));

/** True when `key` is a catalogue variable that exists for documents of `subject`. */
export function isVariableFor(key: string, subject: DocumentSubject): boolean {
  return BY_KEY.get(key)?.subjects.includes(subject) ?? false;
}

export function variablesFor(subject: DocumentSubject): TemplateVariable[] {
  return TEMPLATE_VARIABLES.filter((variable) => variable.subjects.includes(subject));
}

/** What the variables are computed from, besides the snapshot (already formatted). */
export interface VariableSources {
  snapshot: DocumentSnapshot;
  profile: Pick<ProfileFacts, 'nif' | 'nis' | 'rc' | 'ai'>;
  employee: Pick<EmployeeFacts, 'firstName' | 'lastName' | 'firstNameAr' | 'lastNameAr'>;
}

/** Every catalogue variable of a snapshot (the number as set in the snapshot). */
export function variableValues(sources: VariableSources): Record<string, string | null> {
  const { snapshot: s, profile: p, employee: e } = sources;
  const ar = s.lang === 'ar';
  const values: Record<string, string | null> = {
    'document.number': s.number || null,
    'document.issueDate': s.issueDateText,
    'document.city': s.company.city || null,
    'company.legalName': s.company.legalName || null,
    'company.address': s.company.address || null,
    'company.phone': s.company.phone,
    'company.email': s.company.email,
    'company.nif': p.nif,
    'company.nis': p.nis,
    'company.rc': p.rc,
    'company.ai': p.ai,
    'employee.civility': s.employee.civility,
    'employee.fullName': s.employee.fullName,
    'employee.firstName': ar ? (e.firstNameAr ?? e.firstName) : e.firstName,
    'employee.lastName': ar ? (e.lastNameAr ?? e.lastName) : e.lastName,
    'employee.matricule': s.employee.matricule,
    'employee.birthDate': s.employee.birthDateText,
    'employee.birthPlace': s.employee.birthPlace,
    'employee.jobTitle': s.employee.jobTitle,
    'employee.unit': s.employee.unitName,
    'employee.hireDate': s.employee.hireDateText,
    'employee.endDate': s.employee.endDateText,
    'signatory.name': s.signatory.name,
    'signatory.title': s.signatory.title,
  };
  if (s.leave) {
    values['leave.type'] = s.leave.typeLabel;
    values['leave.start'] = s.leave.startText;
    values['leave.end'] = s.leave.endText;
    values['leave.days'] = s.leave.days;
    values['leave.daysText'] = daysPhrase(s.leave.days, s.lang);
    values['leave.resumption'] = s.leave.resumptionText;
  }
  for (const [key, value] of Object.entries(s.fields ?? {})) values[`field.${key}`] = value;
  return values;
}

/** Only the keys a layout uses (what the snapshot records). */
export function pickValues(values: Record<string, string | null>, keys: Iterable<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of [...keys].toSorted()) out[key] = values[key] ?? null;
  return out;
}

export function sampleValue(key: string, lang: DocumentLanguage): string | null {
  return BY_KEY.get(key)?.sample[lang] ?? null;
}
