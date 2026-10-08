import type { Transaction } from 'kysely';
import { demoPdf } from '../../src/modules/documents/index.js';
import { seedDemoRecruitment, seedRecruitment, type SeedApplication, type SeedCandidate, type SeedOpening } from '../../src/modules/recruitment/index.js';
import type { DB } from '../../src/platform/db/schema.js';

/*
 * Recruitment e2e fixture (docs/contracts/recruitment.md › Seed: "the e2e fixture option `recruitment: true` seeds the
 * above for DEMO plus, per matrix target, an open opening with enough applications, notes and files for every
 * consuming row"). TEST DATA — fictitious people. Needs the leave fixture (chef.annaba, the unit heads).
 *
 * Targets: `est` = Agence Constantine (AG-CNE), `ouest` = Agence Oran (AG-ORAN), `other` = BETA (BETA-RH).
 * Per target: a main open opening with a main application (stage `received`, one note, one CV), and POOLS whose items
 * are each used by one request: openings to close, closed openings to reopen, applications to move (received),
 * applications to reopen (rejected), notes and files to delete, candidates to erase (one rejected application each).
 */

const COMPANY_A = '0190a5d0-0000-7000-8000-000000000001';
const COMPANY_B = '0190a5d0-0000-7000-8000-00000000000b';
const USER = {
  admin: '0190a5d0-0000-7000-8000-0000000000aa',
  est: '0190a5d0-0000-7000-8000-0000000000ab',
  beta: '0190a5d0-0000-7000-8000-0000000000bb',
} as const;
const UNIT = {
  est: '0190a5d0-0000-7000-8000-000000000133',
  ouest: '0190a5d0-0000-7000-8000-000000000135',
  other: '0190a5d0-0000-7000-8000-000000000b11',
} as const;

export type RecTarget = keyof typeof UNIT;
const TARGETS: readonly RecTarget[] = ['est', 'ouest', 'other'];
/** Items per pool and target. */
export const REC_POOL = 12;

const fx = (kind: number, target: RecTarget, k: number) => `0190a5d0-0000-7000-9c${String(kind).padStart(2, '0')}-${(TARGETS.indexOf(target) * 0x1000 + k).toString(16).padStart(12, '0')}`;
const pool = (kind: number) => Object.fromEntries(TARGETS.map((t) => [t, Array.from({ length: REC_POOL }, (_, k) => fx(kind, t, k + 1))])) as Record<RecTarget, string[]>;
const one = (kind: number) => Object.fromEntries(TARGETS.map((t) => [t, fx(kind, t, 0)])) as Record<RecTarget, string>;

/** Fixed ids of the fixture (the pools are arrays to `shift()` from). */
export const REC_FX = {
  /** the main open opening of each target */
  opening: one(1),
  /** its main application (stage `received`) and that application's candidate, CV and note */
  application: one(2),
  candidate: one(3),
  file: one(4),
  note: one(5),
  toClose: pool(11),
  toReopen: pool(12),
  toMove: pool(13),
  toReopenApplication: pool(14),
  notesToDelete: pool(15),
  filesToDelete: pool(16),
  toErase: pool(17),
  /** NIN of the Ouest target's main candidate (an Est user must not see it as a duplicate) */
  ouestNin: '199990000000000135',
} as const;

const AT = '2026-09-01T08:00:00Z';
const LATER = '2026-09-10T08:00:00Z';

function build(target: RecTarget): { openings: SeedOpening[]; candidates: SeedCandidate[]; applications: SeedApplication[] } {
  const by = target === 'other' ? USER.beta : USER.admin;
  const noteAuthor = target === 'other' ? USER.beta : USER.est;
  const t = TARGETS.indexOf(target);
  const opening = (id: string, n: number, status: 'open' | 'closed'): SeedOpening => ({
    id,
    // year 2020: never collides with the numbers the API takes
    reference: `REC-2020-${String(t * 1000 + n + 1).padStart(4, '0')}`,
    title: `Poste matrice ${target} ${n}`,
    orgUnitId: UNIT[target],
    contractType: 'cdd',
    posts: 3,
    justification: 'Besoin de test.',
    targetDate: '2031-01-01',
    status,
    requestedBy: by,
    requestedAt: AT,
    openedAt: AT,
    ...(status === 'closed' ? { closed: { at: LATER, by, reason: 'Clôture de test' } } : {}),
  });
  const candidate = (id: string, label: string, extra: Partial<SeedCandidate> = {}): SeedCandidate => ({
    id,
    lastName: `Matrice${target}`,
    firstName: label,
    createdBy: by,
    createdAt: AT,
    ...extra,
  });
  const main = REC_FX.opening[target];
  const openings: SeedOpening[] = [opening(main, 0, 'open')];
  const candidates: SeedCandidate[] = [
    candidate(REC_FX.candidate[target], 'Principal', {
      nin: target === 'ouest' ? REC_FX.ouestNin : null,
      email: `principal.${target}@example.test`,
      phone: `0661 00 00 0${t}`,
      files: [
        { id: REC_FX.file[target], kind: 'cv', title: 'CV', originalFilename: 'cv.pdf', mime: 'application/pdf', content: demoPdf(`TEST DATA - CV matrice ${target}`) },
        ...REC_FX.filesToDelete[target].map((id, k) => ({
          id,
          kind: 'other' as const,
          title: `Pièce ${k}`,
          originalFilename: `piece-${k}.pdf`,
          mime: 'application/pdf' as const,
          content: demoPdf(`TEST DATA - piece ${target} ${k}`),
        })),
      ],
    }),
  ];
  const applications: SeedApplication[] = [
    {
      id: REC_FX.application[target],
      openingId: main,
      candidateId: REC_FX.candidate[target],
      source: 'spontaneous',
      createdBy: by,
      expectedSalary: '55000.00',
      transitions: [{ to: 'received', at: AT, by }],
      notes: [
        { id: REC_FX.note[target], body: 'Note de test', by: noteAuthor, at: AT },
        ...REC_FX.notesToDelete[target].map((id, k) => ({ id, body: `Note à supprimer ${k}`, by: noteAuthor, at: AT })),
      ],
    },
  ];
  for (let k = 0; k < REC_POOL; k++) {
    openings.push(opening(REC_FX.toClose[target][k] ?? '', 100 + k, 'open'), opening(REC_FX.toReopen[target][k] ?? '', 200 + k, 'closed'));
    for (const [kind, ids, rejected] of [
      [21, REC_FX.toMove[target], false],
      [22, REC_FX.toReopenApplication[target], true],
      [23, REC_FX.toErase[target], true],
    ] as const) {
      const candidateId = kind === 23 ? (ids[k] ?? '') : fx(kind, target, k + 1);
      candidates.push(candidate(candidateId, `Pool${kind}-${k}`));
      applications.push({
        // the erase pool is addressed by candidate, the two others by application
        id: kind === 23 ? fx(24, target, k + 1) : (ids[k] ?? ''),
        openingId: main,
        candidateId,
        source: 'other',
        createdBy: by,
        transitions: rejected
          ? [{ to: 'received', at: AT, by }, { to: 'rejected', at: LATER, by, reason: 'other' }]
          : [{ to: 'received', at: AT, by }],
      });
    }
  }
  return { openings, candidates, applications };
}

/** DEMO: the demo data + the Est and Ouest targets; BETA: its target (the defaults of both companies are seeded before). */
export async function seedRecruitmentFixture(tx: Transaction<DB>, nowMs = Date.now()): Promise<void> {
  await seedDemoRecruitment(tx, nowMs);
  for (const target of TARGETS) await seedRecruitment(tx, target === 'other' ? COMPANY_B : COMPANY_A, build(target));
}
