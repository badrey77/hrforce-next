/**
 * The fixed `designed.typ` rendering resolved layouts (docs/contracts/document-templates.md › Rendering, Tests): every
 * block type in French and Arabic, the designer copies of the built-ins print the same text as the built-ins, long
 * values stay inside the margins, text typed as Typst markup prints literally, and the 5-page cap.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, describe, expect, it } from 'vitest';
import { PdfRenderError, TypstPdfRenderer } from '../../../platform/pdf/index.js';
import { builtinLayout } from '../domain/builtin-layouts.js';
import { buildSnapshot, type EmployeeFacts, type LeaveSnapshotFacts, type ProfileFacts, type SnapshotInput } from '../domain/snapshot.js';
import type { TemplateLayout } from '../domain/template-layout.js';
import { resolveLayout } from '../domain/template-resolve.js';
import { variableValues } from '../domain/template-variables.js';
import { DESIGNED_TEMPLATE, type DocumentLanguage, type SystemDocumentTypeCode } from '../domain/types.js';

const renderer = new TypstPdfRenderer({ timeoutMs: 30_000 });
afterAll(() => renderer.close());

const profile: ProfileFacts = {
  legalNameFr: 'Entreprise Démo',
  legalNameAr: 'مؤسسة تجريبية',
  addressFr: '12 rue Didouche Mourad, Alger',
  addressAr: '12 شارع ديدوش مراد، الجزائر',
  cityFr: 'Alger',
  cityAr: 'الجزائر',
  phone: '+213 21 00 00 00',
  email: 'rh@demo.dz',
  nif: '000016000000000',
  nis: null,
  rc: 'RC 16/00',
  ai: null,
  footerFr: 'Données de test',
  footerAr: 'بيانات تجريبية',
  hasLogo: false,
};

const employee: EmployeeFacts = {
  employmentId: 'e1',
  sex: 'F',
  firstName: 'Amina',
  lastName: 'Benali',
  firstNameAr: 'أمينة',
  lastNameAr: 'بن علي',
  matricule: 'EMP-0042',
  birthDate: '1990-03-01',
  birthPlace: 'Annaba',
  jobTitle: 'Chargée de clientèle',
  unitName: 'Agence Annaba',
  unitNameAr: 'وكالة عنابة',
  hireDate: '2019-09-01',
  endDate: '2026-06-30',
  assignments: [
    { jobTitle: 'Agent', validFrom: '2019-09-01', validTo: '2022-04-01' },
    { jobTitle: 'Chargée de clientèle', validFrom: '2022-04-01', validTo: '2026-07-01' },
  ],
};

const signatory = { id: 's1', nameFr: 'Farid Belkacem', nameAr: 'فريد بلقاسم', titleFr: 'DRH', titleAr: 'مدير الموارد البشرية' };

const leave: LeaveSnapshotFacts = {
  requestId: 'r1',
  typeLabels: { fr: 'Congé annuel', ar: 'عطلة سنوية' },
  startDate: '2026-10-12',
  endDate: '2026-10-26',
  days: '15',
  halfDayStart: false,
  halfDayEnd: false,
  resumption: { date: '2026-10-27', afternoon: false },
};

function snapshotOf(type: string, lang: DocumentLanguage, overrides: Partial<SnapshotInput> = {}) {
  const input: SnapshotInput = { type, lang, issueDate: '2026-09-28', profile, employee, signatory, ...overrides };
  return { ...buildSnapshot(input), number: 'X-2026-00001' };
}

async function renderDesigned(layout: TemplateLayout, snapshot: ReturnType<typeof snapshotOf>): Promise<Buffer> {
  const values = variableValues({ snapshot, profile, employee });
  const resolved = resolveLayout(layout, {
    lang: snapshot.lang,
    values,
    sex: snapshot.employee.sex,
    jobTitle: snapshot.employee.jobTitle,
    positions: snapshot.employee.positions ?? [],
  });
  return renderer.render({ template: DESIGNED_TEMPLATE, data: snapshot, options: { specimen: false, logo: null, title: 'Test' }, layout: resolved, standard: 'a-2b' });
}

async function pdfText(pdf: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  return { text: (await extractText(doc, { mergePages: true })).text, pages: doc.numPages };
}

/** Letters and digits only: line breaks, spacing and the order pdf.js gives mixed runs differ between layouts. */
const letters = (value: string) => [...value.replace(/[\sً-ْ]/g, '')].toSorted().join('');

describe('designed.typ', () => {
  const builtins: [SystemDocumentTypeCode, DocumentLanguage][] = [
    ['attestation_travail', 'fr'],
    ['attestation_travail', 'ar'],
    ['certificat_travail', 'fr'],
    ['certificat_travail', 'ar'],
    ['titre_conge', 'fr'],
    ['titre_conge', 'ar'],
  ];

  it.each(builtins)('the designer copy of %s (%s) prints the same text as the built-in', async (type, lang) => {
    const snapshot = snapshotOf(type, lang, type === 'titre_conge' ? { leave } : {});
    const original = await pdfText(await renderer.render({ template: type, data: snapshot, standard: 'a-2b' }));
    const copy = await pdfText(await renderDesigned(builtinLayout(type, lang), snapshot));
    expect(copy.pages).toBe(original.pages);
    expect(letters(copy.text)).toEqual(letters(original.text));
  }, 60_000);

  it.each(['fr', 'ar'] as const)('every block type renders (%s)', async (lang) => {
    const layout: TemplateLayout = {
      v: 1,
      page: { letterhead: true, footer: true, fontSize: 'small', margins: 'wide' },
      blocks: [
        { id: 'a', type: 'title', align: 'center', content: [{ t: 'text', text: 'ORDRE DE MISSION' }] },
        { id: 'b', type: 'heading', align: 'start', content: [{ t: 'text', text: 'Objet', underline: true }] },
        {
          id: 'c',
          type: 'paragraph',
          align: 'justify',
          content: [
            { t: 'var', key: 'employee.civility' },
            { t: 'text', text: ' ' },
            { t: 'var', key: 'employee.fullName', bold: true },
            { t: 'text', text: ' ' },
            { t: 'gender', m: 'est prié', f: 'est priée', x: 'est prié(e)' },
            { t: 'text', text: ' de se rendre à ', italic: true },
            { t: 'var', key: 'field.destination', bold: true, italic: true },
            { t: 'break' },
            { t: 'optional', key: 'employee.birthPlace', content: [{ t: 'text', text: 'Né à ' }, { t: 'var', key: 'employee.birthPlace' }] },
          ],
        },
        { id: 'd', type: 'paragraph', align: 'center', content: [] },
        { id: 'e', type: 'paragraph', align: 'end', when: 'employee.endDate', content: [{ t: 'text', text: 'Fin : ' }, { t: 'var', key: 'employee.endDate' }] },
        { id: 'f', type: 'list', ordered: true, items: [[{ t: 'text', text: 'Un' }], [{ t: 'text', text: 'Deux' }]] },
        { id: 'g', type: 'list', ordered: false, items: [[{ t: 'text', text: 'Trois' }]] },
        {
          id: 'h',
          type: 'table',
          widths: [1, 2, 3],
          headerRow: true,
          borders: true,
          rows: [
            [[{ t: 'text', text: 'A' }], [{ t: 'text', text: 'B' }], [{ t: 'text', text: 'C' }]],
            [[{ t: 'var', key: 'employee.matricule' }], [], [{ t: 'var', key: 'document.number' }]],
          ],
        },
        { id: 'i', type: 'positions' },
        { id: 'j', type: 'spacer', size: 'large' },
        { id: 'k', type: 'divider' },
        { id: 'l', type: 'signature', align: 'start' },
        { id: 'm', type: 'pageBreak' },
        { id: 'n', type: 'paragraph', align: 'start', content: [{ t: 'text', text: 'Page deux' }] },
      ],
    };
    const snapshot = { ...snapshotOf('ordre_mission', lang, { positions: true }), fields: { destination: 'Oran' } };
    const { text, pages } = await pdfText(await renderDesigned(layout, snapshot));
    expect(pages).toBe(2);
    for (const word of ['ORDRE', 'Oran', 'EMP-0042', 'X-2026-00001', 'Trois', 'deux']) expect(text).toContain(word);
    expect(text).toContain('priée'); // sex F
  }, 60_000);

  it('text typed as Typst markup prints literally', async () => {
    const markup = '#panic("pwned") *gras* $x^2$ #read("/etc/passwd") [lien](x) = titre';
    const layout: TemplateLayout = {
      v: 1,
      page: { letterhead: false, footer: false, fontSize: 'normal', margins: 'normal' },
      blocks: [
        { id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'text', text: markup }] },
        { id: 'b', type: 'heading', align: 'start', content: [{ t: 'var', key: 'employee.fullName' }] },
      ],
    };
    const snapshot = snapshotOf('ordre_mission', 'fr', { employee: { ...employee, lastName: '#panic("x") *b*' } });
    const { text } = await pdfText(await renderDesigned(layout, snapshot));
    expect(text.replace(/\s+/g, ' ')).toContain(markup);
    expect(text).toContain('#panic("x") *b*');
  }, 60_000);

  it('long unbroken values stay inside the margins', async () => {
    const long = 'A'.repeat(300);
    const layout: TemplateLayout = {
      v: 1,
      page: { letterhead: true, footer: true, fontSize: 'large', margins: 'narrow' },
      blocks: [
        { id: 'a', type: 'paragraph', align: 'justify', content: [{ t: 'text', text: long }] },
        { id: 'b', type: 'table', widths: [1, 1], headerRow: false, borders: true, rows: [[[{ t: 'text', text: long }], [{ t: 'text', text: 'x' }]]] },
      ],
    };
    const doc = await getDocumentProxy(new Uint8Array(await renderDesigned(layout, snapshotOf('ordre_mission', 'fr'))));
    const page = await doc.getPage(1);
    const margin = (1.6 / 2.54) * 72;
    for (const item of (await page.getTextContent()).items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      const left = item.transform[4] as number;
      expect(left).toBeGreaterThanOrEqual(margin - 4);
      expect(left + item.width).toBeLessThanOrEqual(595.28 - margin + 4);
    }
  }, 60_000);

  it('a document over 5 pages fails with the document-template-too-long marker', async () => {
    const layout: TemplateLayout = {
      v: 1,
      page: { letterhead: false, footer: false, fontSize: 'normal', margins: 'normal' },
      blocks: Array.from({ length: 6 }, (_, i) => [
        { id: `p${i}`, type: 'paragraph' as const, align: 'start' as const, content: [{ t: 'text' as const, text: `Page ${i}` }] },
        { id: `b${i}`, type: 'pageBreak' as const },
      ]).flat(),
    };
    const error = await renderDesigned(layout, snapshotOf('ordre_mission', 'fr')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfRenderError);
    expect((error as PdfRenderError).message).toContain('document-template-too-long');
  }, 60_000);
});
