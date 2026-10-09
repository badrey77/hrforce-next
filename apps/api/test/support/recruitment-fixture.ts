import type { Transaction } from 'kysely';
import { LEAVE_DEMO } from '../../src/modules/leave/index.js';
import { demoPdf } from '../../src/modules/documents/index.js';
import { seedEmployees, type SeedEmployee } from '../../src/modules/employment/index.js';
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
 *
 * Phase B, per target: a fixed interview on the main application and interviews to cancel; a second open opening with
 * 99 posts (`offerOpening`) holding an application under offer (`offered`: PUT offer, hire-prefill), applications to
 * make an offer to, offers to decline / cancel, applications to hire; a third one (`undoOpening`) with hired
 * applications whose employment is ended (undo-hire). Est only: an application of AG-CNE in `interview` whose interview
 * (held two days before the seed) has chef.annaba as its only interviewer — chef heads nothing there.
 */

const COMPANY_A = '0190a5d0-0000-7000-8000-000000000001';
const COMPANY_B = '0190a5d0-0000-7000-8000-00000000000b';
const USER = {
  admin: '0190a5d0-0000-7000-8000-0000000000aa',
  est: '0190a5d0-0000-7000-8000-0000000000ab',
  beta: '0190a5d0-0000-7000-8000-0000000000bb',
} as const;
/** chef.annaba (leave demo seed): head of Agence Annaba, an interviewer here */
const CHEF = LEAVE_DEMO.chef.userId;
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
  // ── Phase B ──
  /** a scheduled interview of the main application (PATCH) and interviews to cancel */
  interview: one(31),
  interviewsToCancel: pool(32),
  /** an open opening with 99 posts for everything about offers */
  offerOpening: one(33),
  /** an application under offer on it (PUT offer, hire-prefill), with its candidate and CV */
  offered: one(34),
  offeredCandidate: one(35),
  offeredFile: one(36),
  toOffer: pool(37),
  toDecline: pool(38),
  toCancelOffer: pool(39),
  toHire: pool(40),
  /** hired applications whose employment is ended (undo-hire): 4 per target, on `undoOpening` */
  undoOpening: one(41),
  toUndo: Object.fromEntries(TARGETS.map((t) => [t, Array.from({ length: 4 }, (_, k) => fx(42, t, k + 1))])) as Record<RecTarget, string[]>,
  /** Est: an application of AG-CNE whose interview has chef.annaba as its only interviewer */
  chefInterview: fx(43, 'est', 0),
  chefApplication: fx(44, 'est', 0),
  chefCandidate: fx(45, 'est', 0),
  chefFile: fx(46, 'est', 0),
} as const;

/** The ended employments behind the undo pool (TEST DATA — fictitious). */
export const REC_UNDO_EMPLOYMENT = Object.fromEntries(TARGETS.map((t) => [t, Array.from({ length: 4 }, (_, k) => fx(47, t, k + 1))])) as Record<RecTarget, string[]>;

const AT = '2026-09-01T08:00:00Z';
const LATER = '2026-09-10T08:00:00Z';

/** The ended employees the undo pool's applications were hired as. */
function undoEmployees(target: RecTarget): SeedEmployee[] {
  const t = TARGETS.indexOf(target);
  return REC_UNDO_EMPLOYMENT[target].map((employmentId, k) => ({
    personId: fx(48, target, k + 1),
    employmentId,
    lastName: `Annulé${target}`,
    firstName: `Embauche${k}`,
    lastNameAr: null,
    firstNameAr: null,
    sex: 'M',
    birthDate: '1991-02-03',
    birthPlace: 'Sétif',
    nin: `19199${String(7_000_000_000_000 + t * 100 + k)}`,
    nss: null,
    rib: null,
    bankName: null,
    matricule: `UNDO-${t}${k}`,
    hireDate: '2026-03-01',
    endDate: '2026-03-31',
    endReason: 'other',
    assignments: [{ id: fx(49, target, k + 1), orgUnitId: UNIT[target], jobTitle: 'Agent', validFrom: '2026-03-01', validTo: '2026-04-01' }],
    salaries: [],
  }));
}

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
  // ── Phase B ──
  const interviewer = target === 'other' ? USER.beta : USER.est;
  const main0 = applications[0];
  if (main0) {
    main0.interviews = [REC_FX.interview[target], ...REC_FX.interviewsToCancel[target]].map((id, k) => ({
      id,
      label: `Entretien ${k}`,
      at: '2031-03-01T09:00:00Z',
      mode: 'on_site' as const,
      by,
      interviewers: [{ user: interviewer }],
    }));
  }
  const big = (id: string, n: number, hiredCount = 0): SeedOpening => ({ ...opening(id, n, 'open'), posts: 99, hiredCount });
  openings.push(big(REC_FX.offerOpening[target], 300), big(REC_FX.undoOpening[target], 301, 4));
  const offer = (id: string, status: 'proposed' | 'accepted' = 'proposed') => ({
    id,
    jobTitle: 'Poste proposé',
    orgUnitId: UNIT[target],
    contractType: 'cdd' as const,
    startDate: '2031-02-01',
    status,
    by,
    at: LATER,
  });
  candidates.push(
    candidate(REC_FX.offeredCandidate[target], 'Offre', {
      files: [{ id: REC_FX.offeredFile[target], kind: 'cv', title: 'CV', originalFilename: 'cv-offre.pdf', mime: 'application/pdf', content: demoPdf(`TEST DATA - CV offre ${target}`) }],
    }),
  );
  applications.push({
    id: REC_FX.offered[target],
    openingId: REC_FX.offerOpening[target],
    candidateId: REC_FX.offeredCandidate[target],
    source: 'other',
    createdBy: by,
    transitions: [{ to: 'received', at: AT, by }, { to: 'offer', at: LATER, by }],
    offer: { ...offer(fx(50, target, 0)), proposedSalary: '58000.00' },
  });
  for (let k = 0; k < REC_POOL; k++) {
    for (const [kind, ids, offered] of [
      [51, REC_FX.toOffer[target], false],
      [52, REC_FX.toDecline[target], true],
      [53, REC_FX.toCancelOffer[target], true],
      [54, REC_FX.toHire[target], true],
    ] as const) {
      const candidateId = fx(kind, target, k + 1);
      candidates.push(candidate(candidateId, `Pool${kind}-${k}`));
      applications.push({
        id: ids[k] ?? '',
        openingId: REC_FX.offerOpening[target],
        candidateId,
        source: 'other',
        createdBy: by,
        transitions: offered ? [{ to: 'received', at: AT, by }, { to: 'offer', at: LATER, by }] : [{ to: 'received', at: AT, by }],
        ...(offered ? { offer: offer(fx(kind + 10, target, k + 1)) } : {}),
      });
    }
  }
  for (const [k, id] of REC_FX.toUndo[target].entries()) {
    const candidateId = fx(55, target, k + 1);
    candidates.push(candidate(candidateId, `Embauché-${k}`, { personId: fx(48, target, k + 1) }));
    applications.push({
      id,
      openingId: REC_FX.undoOpening[target],
      candidateId,
      source: 'other',
      createdBy: by,
      employmentId: REC_UNDO_EMPLOYMENT[target][k] ?? '',
      transitions: [{ to: 'received', at: AT, by }, { to: 'offer', at: AT, by }, { to: 'hired', at: LATER, by }],
      offer: { ...offer(fx(56, target, k + 1), 'accepted'), decidedAt: LATER },
    });
  }
  if (target === 'est') {
    candidates.push(
      candidate(REC_FX.chefCandidate, 'Evalué', {
        nin: '199990000000000777',
        email: 'evalue.est@example.test',
        phone: '0661 77 77 77',
        files: [{ id: REC_FX.chefFile, kind: 'cv', title: 'CV', originalFilename: 'cv-eval.pdf', mime: 'application/pdf', content: demoPdf('TEST DATA - CV chef interview') }],
      }),
    );
    applications.push({
      id: REC_FX.chefApplication,
      openingId: REC_FX.offerOpening.est,
      candidateId: REC_FX.chefCandidate,
      source: 'other',
      createdBy: by,
      expectedSalary: '61000.00',
      transitions: [{ to: 'received', at: AT, by }, { to: 'interview', at: LATER, by }],
      notes: [{ id: fx(57, 'est', 0), body: 'Note RH confidentielle', by: USER.est, at: AT }],
      interviews: [{ id: REC_FX.chefInterview, label: 'Entretien chef', at: '2026-09-20T09:00:00Z', mode: 'on_site', location: 'Salle A', by: USER.est, interviewers: [{ user: CHEF }] }],
    });
  }
  return { openings, candidates, applications };
}

/** DEMO: the demo data + the Est and Ouest targets; BETA: its target (the defaults of both companies are seeded before). */
export async function seedRecruitmentFixture(tx: Transaction<DB>, nowMs = Date.now()): Promise<void> {
  await seedDemoRecruitment(tx, nowMs);
  for (const target of TARGETS) {
    const company = target === 'other' ? COMPANY_B : COMPANY_A;
    await seedEmployees(tx, company, undoEmployees(target));
    await seedRecruitment(tx, company, build(target));
  }
}
