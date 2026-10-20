/**
 * Designer copies of the built-in templates (`attestation_travail@2`, `certificat_travail@2`, `titre_conge@2`): the same
 * wording as the Typst files of apps/api/assets/pdf/templates, as layouts a company can start a draft from
 * (docs/contracts/document-templates.md › assumption 1, `GET /documents/types/:id/builtin-layout`). Rendered with the
 * same snapshot, a copy prints the same text as its built-in (tested); the layout may differ slightly (table widths).
 * Keep in step with the .typ files: changing a built-in's wording changes its copy too.
 */
import type { Block, Inline, LeafInline, TemplateLayout } from './template-layout.js';
import type { DocumentLanguage, SystemDocumentTypeCode } from './types.js';

const t = (text: string, bold = false): LeafInline => ({ t: 'text', text, ...(bold ? { bold: true as const } : {}) });
const v = (key: string, bold = false): LeafInline => ({ t: 'var', key, ...(bold ? { bold: true as const } : {}) });
const g = (m: string, f: string, x: string): LeafInline => ({ t: 'gender', m, f, x });
const opt = (key: string, ...content: LeafInline[]): Inline => ({ t: 'optional', key, content });

let counter = 0;
const id = () => `b${(counter++).toString(36)}`;
const title = (text: string): Block => ({ id: id(), type: 'title', align: 'center', content: [t(text)] });
const p = (...content: Inline[]): Block => ({ id: id(), type: 'paragraph', align: 'justify', content });
const signature = (): Block => ({ id: id(), type: 'signature', align: 'end' });

function layout(blocks: Block[]): TemplateLayout {
  return { v: 1, page: { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' }, blocks };
}

const birthFr = [opt('employee.birthDate', t(', '), g('né', 'née', 'né(e)'), t(' le '), v('employee.birthDate')), opt('employee.birthPlace', t(' à '), v('employee.birthPlace'))];
const birthAr = [opt('employee.birthDate', t('، '), g('المولود', 'المولودة', 'المولود(ة)'), t(' في '), v('employee.birthDate')), opt('employee.birthPlace', t(' بـ'), v('employee.birthPlace'))];

function attestation(lang: DocumentLanguage): TemplateLayout {
  if (lang === 'ar') {
    return layout([
      title('شهادة عمل'),
      p(t('تشهد '), v('company.legalName'), t(' بأن '), v('employee.civility'), t(' '), v('employee.fullName', true), ...birthAr, t('، رقم التسجيل '), v('employee.matricule'), t('، '), g('يعمل', 'تعمل', 'يعمل(تعمل)'), t(' لدى مؤسستنا منذ '), v('employee.hireDate'), t(' بصفة '), v('employee.jobTitle'), t(' ('), v('employee.unit'), t(').')),
      p(t('سلمت هذه الشهادة '), g('للمعني بطلب منه', 'للمعنية بطلب منها', 'للمعني(ة) بطلب منه'), t(' لاستعمالها في حدود ما يسمح به القانون.')),
      signature(),
    ]);
  }
  return layout([
    title('ATTESTATION DE TRAVAIL'),
    p(t('Nous soussignés, '), v('company.legalName'), t(', attestons que '), v('employee.civility'), t(' '), v('employee.fullName', true), ...birthFr, t(', matricule '), v('employee.matricule'), t(', est '), g('employé', 'employée', 'employé(e)'), t(' au sein de notre organisme depuis le '), v('employee.hireDate'), t(' en qualité de '), v('employee.jobTitle'), t(' ('), v('employee.unit'), t(').')),
    p(t('La présente attestation est délivrée à '), g("l'intéressé", "l'intéressée", "l'intéressé(e)"), t(', sur sa demande, pour servir et valoir ce que de droit.')),
    signature(),
  ]);
}

function certificat(lang: DocumentLanguage): TemplateLayout {
  if (lang === 'ar') {
    return layout([
      title('شهادة نهاية العمل'),
      p(t('نشهد نحن الموقعين أدناه، '), v('company.legalName'), t('، بأن '), v('employee.civility'), t(' '), v('employee.fullName', true), ...birthAr, t('، رقم التسجيل '), v('employee.matricule'), t('، '), g('عمل', 'عملت', 'عمل(ت)'), t(' لدى مؤسستنا من '), v('employee.hireDate'), t(' إلى '), v('employee.endDate'), t(' بصفة:')),
      { id: id(), type: 'positions' },
      p(g('وهو حر', 'وهي حرة', 'وهو(هي) حر(ة)'), t(' من كل التزام تجاه مؤسستنا.')),
      p(t('سلمت هذه الشهادة لاستعمالها في حدود ما يسمح به القانون.')),
      signature(),
    ]);
  }
  return layout([
    title('CERTIFICAT DE TRAVAIL'),
    p(t('Nous soussignés, '), v('company.legalName'), t(', certifions que '), v('employee.civility'), t(' '), v('employee.fullName', true), ...birthFr, t(', matricule '), v('employee.matricule'), t(', a été '), g('employé', 'employée', 'employé(e)'), t(' au sein de notre organisme du '), v('employee.hireDate'), t(' au '), v('employee.endDate'), t(' en qualité de :')),
    { id: id(), type: 'positions' },
    p(v('employee.civility'), t(' '), v('employee.fullName'), t(' est libre de tout engagement envers notre organisme.')),
    p(t('Le présent certificat est délivré pour servir et valoir ce que de droit.')),
    signature(),
  ]);
}

function titre(lang: DocumentLanguage): TemplateLayout {
  const row = (label: string, key: string): Inline[][] => [[t(label, true)], [v(key)]];
  const table = (labels: string[]): Block => ({
    id: id(),
    type: 'table',
    widths: [4, 6],
    headerRow: false,
    borders: true,
    rows: ['employee.fullName', 'employee.matricule', 'employee.unit', 'employee.jobTitle', 'leave.type', 'leave.start', 'leave.end', 'leave.days', 'leave.resumption'].map((key, i) =>
      row(labels[i] ?? '', key),
    ),
  });
  if (lang === 'ar') {
    return layout([
      title('سند عطلة'),
      p(t('يرخص '), g('للسيد', 'للسيدة', 'للسيد(ة)'), t(' '), v('employee.fullName', true), t(' بالاستفادة من '), v('leave.type'), t(' من '), v('leave.start'), t(' إلى '), v('leave.end'), t('، أي ما مجموعه '), v('leave.daysText'), t('.')),
      { id: id(), type: 'spacer', size: 'small' },
      table(['الموظف(ة)', 'رقم التسجيل', 'الهيكل', 'الوظيفة', 'نوع العطلة', 'من', 'إلى', 'عدد الأيام', 'تاريخ استئناف العمل']),
      signature(),
    ]);
  }
  return layout([
    title('TITRE DE CONGÉ'),
    p(v('employee.civility'), t(' '), v('employee.fullName', true), t(' est '), g('autorisé', 'autorisée', 'autorisé(e)'), t(' à bénéficier d’un congé ('), v('leave.type'), t(') du '), v('leave.start'), t(' au '), v('leave.end'), t(' inclus, soit '), v('leave.daysText'), t('.')),
    { id: id(), type: 'spacer', size: 'small' },
    table(['Employé(e)', 'Matricule', 'Structure', 'Fonction', 'Type de congé', 'Du', 'Au', 'Nombre de jours', 'Date de reprise']),
    signature(),
  ]);
}

/** A fresh copy (new block ids each call are fine: ids only need to be unique within a layout). */
export function builtinLayout(code: SystemDocumentTypeCode, lang: DocumentLanguage): TemplateLayout {
  counter = 0;
  switch (code) {
    case 'attestation_travail':
      return attestation(lang);
    case 'certificat_travail':
      return certificat(lang);
    case 'titre_conge':
      return titre(lang);
  }
}
