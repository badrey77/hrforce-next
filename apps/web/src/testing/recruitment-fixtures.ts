/** TEST DATA (fictitious people) shaped like docs/contracts/recruitment.md. */
import type { WorkflowProgress } from '../app/core/leave/leave.models';
import type {
  ApplicationDetailView,
  BoardCard,
  BoardView,
  CandidateFileView,
  CandidateView,
  ComparisonView,
  CriterionRef,
  CriterionView,
  EvaluationView,
  HirePrefillView,
  InterviewView,
  KnownPersonView,
  MyInterviewView,
  MyOpeningDetailView,
  OfferView,
  OpeningDetailView,
  OpeningRef,
  OpeningTaskSummary,
  OpeningView,
  ReasonView,
  Stage,
  StageCounts,
  SummaryView,
} from '../app/core/recruitment/recruitment.models';

export const UNIT_ANNABA = { id: 'u-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' };

export const OPENING_PROGRESS: WorkflowProgress = {
  status: 'pending',
  currentStep: 0,
  steps: [
    { key: 'manager', kind: 'manager', labels: { fr: 'Responsable', ar: 'المسؤول المباشر', en: 'Manager' }, state: 'current' },
    { key: 'hr', kind: 'permission', permission: 'recruitment.approve_opening', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' }, state: 'pending' },
  ],
};

export const CRITERIA: readonly CriterionRef[] = [
  { id: 'cr-skills', labels: { fr: 'Compétences techniques', ar: 'الكفاءات التقنية', en: 'Technical skills' } },
  { id: 'cr-fit', labels: { fr: 'Adéquation au poste', ar: 'الملاءمة للمنصب', en: 'Fit for the post' } },
];

export function stageCounts(counts: Partial<Record<Stage, number>> = {}): StageCounts {
  const full = { received: 0, shortlisted: 0, interview: 0, offer: 0, hired: 0, rejected: 0, withdrawn: 0, ...counts };
  return { ...full, total: Object.values(full).reduce((sum, n) => sum + n, 0) };
}

export function openingView(overrides: Partial<OpeningView> = {}): OpeningView {
  return {
    id: 'o-1',
    reference: 'REC-2026-0001',
    title: 'Chargé(e) de clientèle',
    unit: UNIT_ANNABA,
    site: { id: 's-annaba', code: 'ANB', name: 'Annaba centre' },
    siteInherited: true,
    contractType: 'cdi',
    posts: 2,
    hiredCount: 0,
    justification: 'Renfort du guichet.',
    targetDate: '2026-12-01',
    anemReference: null,
    status: 'open',
    requestedAt: '2026-10-01T08:00:00Z',
    requestedBy: { id: 'u-chef', displayName: 'Chef Annaba' },
    openedAt: '2026-10-02T09:00:00Z',
    closed: null,
    workflow: { ...OPENING_PROGRESS, status: 'approved', currentStep: null },
    rejectionComment: null,
    criteria: CRITERIA,
    counts: stageCounts({ received: 2, shortlisted: 1, interview: 2, rejected: 1 }),
    _actions: ['update', 'close', 'add_application'],
    ...overrides,
  };
}

export function openingDetail(overrides: Partial<OpeningDetailView> = {}): OpeningDetailView {
  return { ...openingView(), history: [], ...overrides };
}

export function myOpeningDetail(overrides: Partial<MyOpeningDetailView> = {}): MyOpeningDetailView {
  return { ...openingView(), roles: ['requester', 'head'], _actions: [], history: [], applications: [], ...overrides };
}

export function candidateFile(overrides: Partial<CandidateFileView> = {}): CandidateFileView {
  return {
    id: 'f-1',
    kind: 'cv',
    title: 'CV',
    originalFilename: 'cv-test.pdf',
    mime: 'application/pdf',
    sizeBytes: 2048,
    uploadedAt: '2026-10-03T10:00:00Z',
    uploadedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    _actions: ['delete'],
    ...overrides,
  };
}

export const CANDIDATE_NAME = { lastName: 'TESTEUR', firstName: 'Nadia', lastNameAr: 'تستور', firstNameAr: 'نادية' };

export function boardCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'a-1',
    candidate: { id: 'cand-1', ...CANDIDATE_NAME },
    stage: 'received',
    stageSince: '2026-10-03T10:00:00Z',
    source: 'anem',
    hasCv: true,
    notes: 2,
    formerEmployee: false,
    rejectionReason: null,
    moveTargets: ['shortlisted', 'interview', 'rejected', 'withdrawn'],
    nextInterviewAt: null,
    average: null,
    pendingEvaluations: 0,
    _actions: ['move'],
    ...overrides,
  };
}

export function boardView(cards: readonly BoardCard[] = [boardCard()], overrides: Partial<BoardView> = {}): BoardView {
  const stages: readonly Stage[] = ['received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
  return {
    opening: openingView(),
    columns: stages.map((stage) => {
      const own = cards.filter((card) => card.stage === stage);
      return { stage, count: own.length, cards: own };
    }),
    purged: 0,
    ...overrides,
  };
}

export const OPENING_REF: OpeningRef = { id: 'o-1', reference: 'REC-2026-0001', title: 'Chargé(e) de clientèle', unit: UNIT_ANNABA, status: 'open' };

export const KNOWN_PERSON: KnownPersonView = {
  personId: 'p-9',
  person: { lastName: 'ANCIEN', firstName: 'Test', lastNameAr: null, firstNameAr: null },
  linked: false,
  hasOpenEmployment: false,
  latestEmployment: { id: 'e-9', matricule: 'EMP-0099', hireDate: '2020-01-05', endDate: '2024-06-30', unit: UNIT_ANNABA },
};

export function candidateView(overrides: Partial<CandidateView> = {}): CandidateView {
  return {
    id: 'cand-1',
    person: CANDIDATE_NAME,
    birthDate: '1995-04-12',
    birthPlace: 'Annaba',
    sex: 'F',
    nationality: 'DZ',
    nin: '199504120000000017',
    email: 'nadia.testeur@example.test',
    phone: '0555 00 00 01',
    informedOn: null,
    createdAt: '2026-10-03T10:00:00Z',
    createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
    knownPerson: null,
    files: [candidateFile()],
    applications: [
      { id: 'a-1', opening: OPENING_REF, stage: 'received', stageSince: '2026-10-03T10:00:00Z', source: 'anem', createdAt: '2026-10-03T10:00:00Z', decidedAt: null, rejectionReason: null },
    ],
    _actions: ['update', 'upload', 'link_person', 'erase'],
    ...overrides,
  };
}

export function applicationDetail(overrides: Partial<ApplicationDetailView> = {}): ApplicationDetailView {
  return {
    id: 'a-1',
    opening: OPENING_REF,
    stage: 'received',
    stageSince: '2026-10-03T10:00:00Z',
    source: 'anem',
    createdAt: '2026-10-03T10:00:00Z',
    decidedAt: null,
    rejectionReason: null,
    candidate: candidateView(),
    stages: [{ id: 'st-1', from: null, to: 'received', at: '2026-10-03T10:00:00Z', by: { id: 'u-amina', displayName: 'Amina Benali' }, rejectionReason: null, comment: null, autoCause: null }],
    notes: [{ id: 'n-1', body: 'Bon contact au téléphone.', createdAt: '2026-10-04T09:00:00Z', createdBy: { id: 'u-amina', displayName: 'Amina Benali' }, _actions: ['delete'] }],
    salary: { expected: '65000.00', proposed: null },
    _redacted: [],
    moveTargets: ['shortlisted', 'interview', 'rejected', 'withdrawn'],
    interviews: [],
    offer: null,
    average: null,
    employment: null,
    _actions: ['move', 'add_note', 'update', 'update_salary'],
    ...overrides,
  };
}

export function reasonView(overrides: Partial<ReasonView> = {}): ReasonView {
  return {
    id: 'r-exp',
    code: 'experience',
    labels: { fr: 'Expérience insuffisante', ar: 'خبرة غير كافية', en: 'Not enough experience' },
    active: true,
    sortOrder: 20,
    isSystem: true,
    autoOnly: false,
    ...overrides,
  };
}

export const REASONS: readonly ReasonView[] = [
  reasonView(),
  reasonView({ id: 'r-closed', code: 'opening_closed', labels: { fr: 'Recrutement clôturé', ar: 'تم إغلاق عملية التوظيف', en: 'Recruitment closed' }, sortOrder: 100, autoOnly: true }),
  reasonView({ id: 'r-old', code: 'old_one', labels: { fr: 'Ancien motif', ar: 'سبب قديم', en: 'Old reason' }, sortOrder: 30, isSystem: false, active: false }),
];

export const SUMMARY: SummaryView = {
  openings: { pending: 1, open: 2, filled: 1, closed: 1, rejected: 1, cancelled: 0 },
  applications: { received: 4, shortlisted: 1, interview: 2, offer: 0 },
  interviewsNext7Days: 3,
  offersPending: 1,
};

export function openingTaskSummary(): OpeningTaskSummary {
  return {
    type: 'recruitment_opening',
    id: 'o-2',
    reference: 'REC-2026-0002',
    title: "Agent d'accueil",
    unit: UNIT_ANNABA,
    site: null,
    contractType: 'cdd',
    posts: 1,
    justification: 'Remplacement.\nSaison haute.',
    targetDate: '2026-11-15',
    requestedBy: { id: 'u-chef', displayName: 'Chef Annaba' },
  };
}

// --- Phase B ---

export const COMPANY_CRITERIA: readonly CriterionView[] = [
  { id: 'cr-skills', code: 'skills', labels: CRITERIA[0]?.labels ?? { fr: '', ar: '', en: '' }, active: true, sortOrder: 10, isSystem: true },
  { id: 'cr-fit', code: 'fit', labels: CRITERIA[1]?.labels ?? { fr: '', ar: '', en: '' }, active: true, sortOrder: 20, isSystem: true },
  { id: 'cr-motivation', code: 'motivation', labels: { fr: 'Motivation', ar: 'الحافز', en: 'Motivation' }, active: true, sortOrder: 30, isSystem: true },
  { id: 'cr-old', code: 'old_one', labels: { fr: 'Ancien critère', ar: 'معيار قديم', en: 'Old criterion' }, active: false, sortOrder: 40, isSystem: false },
];

export function evaluationView(overrides: Partial<EvaluationView> = {}): EvaluationView {
  return { interviewer: { id: 'u-chef', displayName: 'Chef Annaba' }, submittedAt: null, scores: [], overall: null, recommendation: null, comment: null, ...overrides };
}

export function interviewView(overrides: Partial<InterviewView> = {}): InterviewView {
  return {
    id: 'i-1',
    applicationId: 'a-1',
    label: 'Entretien technique',
    scheduledAt: '2026-10-12T09:00:00Z',
    date: '2026-10-12',
    time: '10:00',
    durationMinutes: 60,
    mode: 'on_site',
    location: 'Salle 2',
    status: 'scheduled',
    state: 'upcoming',
    cancelReason: null,
    createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
    evaluations: [evaluationView()],
    average: null,
    evaluationsHidden: false,
    _actions: ['update', 'cancel'],
    ...overrides,
  };
}

export function myInterviewView(overrides: Partial<MyInterviewView> = {}): MyInterviewView {
  return {
    id: 'i-1',
    label: 'Entretien technique',
    scheduledAt: '2026-10-05T09:00:00Z',
    date: '2026-10-05',
    time: '10:00',
    durationMinutes: 60,
    mode: 'on_site',
    location: 'Salle 2',
    opening: { id: 'o-1', reference: 'REC-2026-0001', title: 'Chargé(e) de clientèle', unit: UNIT_ANNABA },
    applicationId: 'a-1',
    candidate: CANDIDATE_NAME,
    files: [candidateFile({ _actions: [] })],
    criteria: CRITERIA,
    evaluation: { submittedAt: null, scores: [], overall: null, recommendation: null, comment: null },
    _actions: ['evaluate'],
    ...overrides,
  };
}

export function offerView(overrides: Partial<OfferView> = {}): OfferView {
  return {
    id: 'of-1',
    jobTitle: 'Chargé(e) de clientèle',
    unit: UNIT_ANNABA,
    site: null,
    contractType: 'cdi',
    startDate: '2026-11-02',
    note: null,
    status: 'proposed',
    decidedAt: null,
    createdAt: '2026-10-07T10:00:00Z',
    createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
    ...overrides,
  };
}

export function comparisonView(overrides: Partial<ComparisonView> = {}): ComparisonView {
  return {
    opening: OPENING_REF,
    criteria: CRITERIA,
    rows: [
      {
        applicationId: 'a-1',
        candidate: { id: 'cand-1', ...CANDIDATE_NAME },
        stage: 'interview',
        interviews: 1,
        evaluations: { submitted: 2, expected: 2 },
        criteria: [
          { criterionId: 'cr-skills', average: 4.5 },
          { criterionId: 'cr-fit', average: 3 },
        ],
        average: 3.8,
        recommendations: { strong_yes: 1, yes: 1, no: 0, strong_no: 0 },
        comments: [{ interviewer: { id: 'u-chef', displayName: 'Chef Annaba' }, interviewLabel: 'Entretien technique', recommendation: 'yes', comment: 'Bonne maîtrise du métier.' }],
        hidden: false,
      },
      {
        applicationId: 'a-2',
        candidate: { id: 'cand-2', lastName: 'AUTRE', firstName: 'Test', lastNameAr: null, firstNameAr: null },
        stage: 'interview',
        interviews: 1,
        evaluations: { submitted: 0, expected: 2 },
        criteria: [
          { criterionId: 'cr-skills', average: null },
          { criterionId: 'cr-fit', average: null },
        ],
        average: null,
        recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 },
        comments: [],
        hidden: false,
      },
      {
        applicationId: 'a-3',
        candidate: { id: 'cand-3', lastName: 'TROIS', firstName: 'Test', lastNameAr: null, firstNameAr: null },
        stage: 'offer',
        interviews: 2,
        evaluations: { submitted: 1, expected: 1 },
        criteria: [
          { criterionId: 'cr-skills', average: 5 },
          { criterionId: 'cr-fit', average: 4 },
        ],
        average: 4.5,
        recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 },
        comments: [],
        hidden: false,
      },
    ],
    ...overrides,
  };
}

export function hirePrefill(overrides: Partial<HirePrefillView> = {}): HirePrefillView {
  return {
    person: {
      personId: null,
      lastName: 'TESTEUR',
      firstName: 'Nadia',
      lastNameAr: 'تستور',
      firstNameAr: 'نادية',
      birthDate: '1995-04-12',
      birthPlace: 'Annaba',
      sex: 'F',
      nationality: 'DZ',
      nin: '199504120000000017',
      email: 'nadia.testeur@example.test',
      phone: '0555 00 00 01',
      informedOn: null,
    },
    knownPerson: null,
    orgUnitId: 'u-annaba',
    siteId: null,
    jobTitle: 'Chargé(e) de clientèle',
    hireDate: '2026-11-02',
    files: [candidateFile({ _actions: [] }), candidateFile({ id: 'f-2', kind: 'diploma', title: 'Diplôme', originalFilename: 'diplome.png', mime: 'image/png', _actions: [] })],
    defaultCopyFileIds: ['f-1'],
    opening: OPENING_REF,
    candidateId: 'cand-1',
    expectedStage: 'offer',
    ...overrides,
  };
}

/** A problem+json answer for `req.flush(body, options)`. */
export function recruitmentProblem(status: number, slug: string | null, errors?: { field: string; code: string; message?: string }[]) {
  return {
    body: {
      type: slug ? `urn:hrforce:problem:${slug}` : 'about:blank',
      title: 'Problem',
      status,
      ...(errors ? { errors: errors.map((e) => ({ message: '', ...e })) } : {}),
    },
    options: { status, statusText: 'Problem' },
  };
}
