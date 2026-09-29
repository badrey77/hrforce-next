/**
 * The real Typst templates (apps/api/assets/pdf/templates) rendered from real snapshots: long unbroken values stay
 * inside the page margins, and the Arabic titre de congé states the day count with Arabic number agreement
 * (docs/contracts/documents.md › Wording).
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, describe, expect, it } from 'vitest';
import { TypstPdfRenderer } from '../../../platform/pdf/index.js';
import { buildSnapshot, type EmployeeFacts, type LeaveSnapshotFacts, type ProfileFacts, type SnapshotInput } from '../domain/snapshot.js';
import type { DocumentLanguage, DocumentTypeCode } from '../domain/types.js';

const renderer = new TypstPdfRenderer({ timeoutMs: 20_000 });
afterAll(() => renderer.close());

/** A4 width and the templates' horizontal margin (2.2 cm), in PDF points. */
const PAGE_WIDTH = 595.28;
const MARGIN_X = (2.2 / 2.54) * 72;
/** hanging punctuation (Typst lets a final hyphen or comma overhang the margin a little) and rounding */
const TOLERANCE = 4;

const LONG = 'A'.repeat(200);
const LONG_AR = 'ب'.repeat(200);

const profile: ProfileFacts = {
  legalNameFr: `Entreprise ${LONG}`,
  legalNameAr: `مؤسسة ${LONG_AR}`,
  addressFr: `12 rue ${LONG}, Alger`,
  addressAr: `12 شارع ${LONG_AR}، الجزائر`,
  cityFr: 'Alger',
  cityAr: 'الجزائر',
  phone: '+213 21 00 00 00',
  email: `${'x'.repeat(120)}@example.dz`,
  nif: '0'.repeat(120),
  nis: null,
  rc: null,
  ai: null,
  footerFr: `Pied ${LONG}`,
  footerAr: `تذييل ${LONG_AR}`,
  hasLogo: false,
};

const employee: EmployeeFacts = {
  employmentId: 'e1',
  sex: 'F',
  firstName: 'Amina',
  lastName: LONG,
  firstNameAr: 'أمينة',
  lastNameAr: LONG_AR,
  matricule: 'EMP-0042',
  birthDate: '1990-03-01',
  birthPlace: LONG,
  jobTitle: LONG,
  unitName: LONG,
  unitNameAr: LONG_AR,
  hireDate: '2019-09-01',
  endDate: '2026-06-30',
  assignments: [
    { jobTitle: 'Agent', validFrom: '2019-09-01', validTo: '2022-04-01' },
    { jobTitle: LONG, validFrom: '2022-04-01', validTo: '2026-07-01' },
  ],
};

const signatory = { id: 's1', nameFr: LONG, nameAr: LONG_AR, titleFr: LONG, titleAr: LONG_AR };

const leave = (days: string): LeaveSnapshotFacts => ({
  requestId: 'r1',
  typeLabels: { fr: `Congé ${LONG}`, ar: `عطلة ${LONG_AR}` },
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  days,
  halfDayStart: false,
  halfDayEnd: false,
  resumption: { date: '2026-10-15', afternoon: false },
});

function snapshot(type: DocumentTypeCode, lang: DocumentLanguage, overrides: Partial<SnapshotInput> = {}) {
  const input: SnapshotInput = { type, lang, issueDate: '2026-09-28', profile, employee, signatory, ...overrides };
  if (type === 'titre_conge' && !input.leave) input.leave = leave('3');
  return { ...buildSnapshot(input), number: 'TC-2026-00001' };
}

interface Run {
  text: string;
  left: number;
  right: number;
  y: number;
}

async function textRuns(pdf: Buffer): Promise<{ runs: Run[]; text: string }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const runs: Run[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      const left = item.transform[4] as number;
      runs.push({ text: item.str, left, right: left + item.width, y: Math.round((item.transform[5] as number) + (n - 1) * -10_000) });
    }
  }
  return { runs, text: (await extractText(doc, { mergePages: true })).text };
}

/** pdf.js returns a tanwin as its own run, a little off its letter: compare letters and digits only. */
const letters = (value: string) => value.replace(/[\u064B-\u0652\s]/g, '');

/** Arabic lines in reading order: runs grouped by baseline, top to bottom, each line right to left. */
function rtlLines(runs: readonly Run[]): string {
  const lines = new Map<number, Run[]>();
  for (const r of runs) lines.set(r.y, [...(lines.get(r.y) ?? []), r]);
  return [...lines.entries()]
    .toSorted(([a], [b]) => b - a)
    .map(([, line]) => line.toSorted((a, b) => b.left - a.left).map((r) => r.text.trim()).join(' '))
    .join(' ');
}

describe('document templates', () => {
  const cases: [DocumentTypeCode, DocumentLanguage][] = [
    ['attestation_travail', 'fr'],
    ['attestation_travail', 'ar'],
    ['certificat_travail', 'fr'],
    ['certificat_travail', 'ar'],
    ['titre_conge', 'fr'],
    ['titre_conge', 'ar'],
  ];

  it.each(cases)('%s (%s): 200-character unbroken values break inside the margins', async (type, lang) => {
    const pdf = await renderer.render({ template: type, data: snapshot(type, lang), standard: 'a-2b' });
    const { runs, text } = await textRuns(pdf);
    expect(runs.length).toBeGreaterThan(10);
    const outside = runs.filter((r) => r.left < MARGIN_X - TOLERANCE || r.right > PAGE_WIDTH - MARGIN_X + TOLERANCE);
    expect(outside.map((r) => `${r.left.toFixed(1)}–${r.right.toFixed(1)} ${r.text.slice(0, 20)}`)).toEqual([]);
    // every character of the long values is still printed (broken across lines, not cut)
    const letter = lang === 'ar' ? 'ب' : 'A';
    expect(text.split(letter).length - 1).toBeGreaterThanOrEqual(600);
  }, 30_000);

  it('normal values: the long-token rule leaves ordinary words alone (no break inside a word)', async () => {
    const plain = buildSnapshot({
      type: 'attestation_travail',
      lang: 'fr',
      issueDate: '2026-09-28',
      profile: { ...profile, legalNameFr: 'Entreprise Démo', addressFr: '12 rue Didouche Mourad, Alger', email: 'rh@demo.dz', nif: '000016000000000', footerFr: 'Données de test' },
      employee: { ...employee, lastName: 'Benali', birthPlace: 'Annaba', jobTitle: 'Chargée de clientèle', unitName: 'Agence Annaba', endDate: null },
      signatory: { ...signatory, nameFr: 'Souad Cherif', titleFr: 'Directrice régionale' },
    });
    const { text } = await textRuns(await renderer.render({ template: 'attestation_travail', data: { ...plain, number: 'ATT-2026-00001' } }));
    for (const word of ['Entreprise Démo', 'Chargée de clientèle', 'Agence Annaba', 'rh@demo.dz', '000016000000000']) {
      expect(text).toContain(word);
    }
  }, 30_000);

  it.each([
    ['1', 'أي ما مجموعه يوم واحد'],
    ['2', 'أي ما مجموعه يومان'],
    ['3', 'أي ما مجموعه 3 أيام'],
    ['10', 'أي ما مجموعه 10 أيام'],
    ['11', 'أي ما مجموعه 11 يومًا'],
    ['30', 'أي ما مجموعه 30 يومًا'],
    ['100', 'أي ما مجموعه 100 يوم'],
    ['103', 'أي ما مجموعه 103 أيام'],
    ['0.5', 'أي ما مجموعه نصف يوم'],
    ['2.5', 'أي ما مجموعه 2.5 يوم'],
  ])('Arabic titre de congé: %s day(s) → « %s »', async (days, phrase) => {
    const plainLeave = { ...leave(days), typeLabels: { fr: 'Congé annuel', ar: 'عطلة سنوية' } };
    const data = snapshot('titre_conge', 'ar', { employee: { ...employee, lastNameAr: 'بن علي' }, leave: plainLeave });
    const printed = rtlLines((await textRuns(await renderer.render({ template: 'titre_conge', data }))).runs);
    expect(printed).toContain('، أي ما');
    expect(letters(printed)).toContain(letters(`مجموعه ${phrase.split('مجموعه ')[1]}.`));
    if (phrase.includes('\u064B')) expect(printed).toContain('\u064B');
  }, 30_000);

  it('French titre de congé keeps « soit N jours »', async () => {
    const data = snapshot('titre_conge', 'fr', { leave: { ...leave('1'), typeLabels: { fr: 'Congé annuel', ar: 'عطلة سنوية' } } });
    const { text } = await textRuns(await renderer.render({ template: 'titre_conge', data }));
    expect(text.replace(/\s+/g, ' ')).toContain('soit 1 jour.');
  }, 30_000);
});
