/**
 * The document snapshot (docs/contracts/documents.md › Snapshot = template input, ADR 008 › Decision 4): the exact JSON
 * a template receives, every printed value already formatted here — the templates only lay it out. Stored with the
 * issued document (audit, search, "what did we certify?"). Pure: no Nest, no Kysely.
 *
 * Formatting rules: Western digits in both languages; dates "28 septembre 2026" (fr, "1er" for the first day of a
 * month) / "28 سبتمبر 2026" (ar, Algerian month names); names in Arabic when the Arabic parts exist (each part falls
 * back to the Latin one); day amounts "2,5" (fr) / "2.5" (ar); the job title as recorded (Latin — assumption 11).
 */
import type { DocumentLanguage, DocumentTypeCode } from './types.js';

export interface DocumentSnapshot {
  v: 1;
  type: DocumentTypeCode;
  lang: DocumentLanguage;
  /** set just before rendering (the allocated number) */
  number: string;
  /** ISO, also the PDF document date */
  issueDate: string;
  issueDateText: string;
  company: {
    legalName: string;
    address: string;
    city: string;
    phone: string | null;
    email: string | null;
    ids: { label: string; value: string }[];
    footer: string | null;
    hasLogo: boolean;
  };
  employee: {
    civility: string;
    /** 'M' | 'F' | null — the templates' gender agreement (né/née, المولود/المولودة) */
    sex: 'M' | 'F' | null;
    fullName: string;
    matricule: string;
    birthDateText: string | null;
    birthPlace: string | null;
    jobTitle: string;
    unitName: string;
    hireDateText: string;
    endDateText: string | null;
    positions?: { jobTitle: string; fromText: string; toText: string }[];
  };
  leave?: {
    typeLabel: string;
    startText: string;
    endText: string;
    days: string;
    halfDayStart: boolean;
    halfDayEnd: boolean;
    resumptionText: string;
  };
  signatory: { name: string; title: string };
  ref: { employmentId: string; leaveRequestId?: string; signatoryId: string };
}

const MONTHS: Readonly<Record<DocumentLanguage, readonly string[]>> = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  // Algerian (Maghreb) month names
  ar: ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};

/** 2026-09-28 → "28 septembre 2026" / "28 سبتمبر 2026"; the 1st of a month is "1er" in French. */
export function dateText(iso: string, lang: DocumentLanguage): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  const day = Number(m[3]);
  const month = MONTHS[lang][Number(m[2]) - 1];
  if (!month) throw new Error(`not an ISO date: ${iso}`);
  const dayText = lang === 'fr' && day === 1 ? '1er' : String(day);
  return `${dayText} ${month} ${m[1]}`;
}

/** "2.5" → "2,5" (fr) / "2.5" (ar); whole numbers without decimals. */
export function daysText(days: string | number, lang: DocumentLanguage): string {
  const n = typeof days === 'number' ? days : Number(days);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return lang === 'fr' ? text.replace('.', ',') : text;
}

const CIVILITY: Readonly<Record<DocumentLanguage, Record<'M' | 'F' | 'X', string>>> = {
  fr: { M: 'M.', F: 'Mme', X: 'M./Mme' },
  ar: { M: 'السيد', F: 'السيدة', X: 'السيد(ة)' },
};

export function civilityOf(sex: string | null, lang: DocumentLanguage): string {
  return CIVILITY[lang][sex === 'M' || sex === 'F' ? sex : 'X'];
}

/** Arabic: the Arabic parts when present, each part falling back to the Latin one. French: Latin. */
export function fullNameOf(p: { firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null }, lang: DocumentLanguage): string {
  if (lang === 'ar') return `${p.firstNameAr ?? p.firstName} ${p.lastNameAr ?? p.lastName}`;
  return `${p.firstName} ${p.lastName}`;
}

const ID_LABELS: Readonly<Record<DocumentLanguage, Record<'nif' | 'nis' | 'rc' | 'ai', string>>> = {
  fr: { nif: 'NIF', nis: 'NIS', rc: 'RC', ai: 'Art. d’imposition' },
  ar: { nif: 'رقم التعريف الجبائي', nis: 'رقم التعريف الإحصائي', rc: 'السجل التجاري', ai: 'رقم المادة الجبائية' },
};

/** The company profile as stored (null = not filled in). */
export interface ProfileFacts {
  legalNameFr: string | null;
  legalNameAr: string | null;
  addressFr: string | null;
  addressAr: string | null;
  cityFr: string | null;
  cityAr: string | null;
  phone: string | null;
  email: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  ai: string | null;
  footerFr: string | null;
  footerAr: string | null;
  hasLogo: boolean;
}

/** The fields a document in `lang` prints and needs (contract › Issuing rules: document-profile-incomplete). */
export function missingProfileFields(profile: ProfileFacts | null, lang: DocumentLanguage): string[] {
  const needed = lang === 'ar' ? (['legalNameAr', 'addressAr', 'cityAr'] as const) : (['legalNameFr', 'addressFr', 'cityFr'] as const);
  return needed.filter((field) => !profile?.[field]);
}

export interface AssignmentFacts {
  jobTitle: string;
  validFrom: string;
  /** exclusive (the day after the last day), null = open */
  validTo: string | null;
}

export interface EmployeeFacts {
  employmentId: string;
  sex: string | null;
  firstName: string;
  lastName: string;
  firstNameAr: string | null;
  lastNameAr: string | null;
  matricule: string;
  birthDate: string | null;
  birthPlace: string | null;
  jobTitle: string;
  unitName: string;
  unitNameAr: string | null;
  hireDate: string;
  /** inclusive last day worked */
  endDate: string | null;
  /** every assignment, oldest first (certificat: the positions held) */
  assignments: readonly AssignmentFacts[];
}

export interface LeaveSnapshotFacts {
  requestId: string;
  typeLabels: { fr: string; ar: string };
  startDate: string;
  endDate: string;
  days: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  resumption: { date: string; afternoon: boolean };
}

export interface SignatoryFacts {
  id: string;
  nameFr: string;
  nameAr: string;
  titleFr: string;
  titleAr: string;
}

export interface SnapshotInput {
  type: DocumentTypeCode;
  lang: DocumentLanguage;
  issueDate: string;
  /** must be complete for `lang` (missingProfileFields empty) */
  profile: ProfileFacts;
  employee: EmployeeFacts;
  leave?: LeaveSnapshotFacts;
  signatory: SignatoryFacts;
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive distinct job titles (certificat): assignments with the same title one after the other merge; each
 * position runs from its first day to its last day (the day before the next title, the end date for the last one).
 */
export function positionsOf(assignments: readonly AssignmentFacts[], endDate: string | null): { jobTitle: string; from: string; to: string }[] {
  const sorted = [...assignments].toSorted((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  const merged: { jobTitle: string; from: string; validTo: string | null }[] = [];
  for (const a of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.jobTitle === a.jobTitle) previous.validTo = a.validTo;
    else merged.push({ jobTitle: a.jobTitle, from: a.validFrom, validTo: a.validTo });
  }
  return merged.map((position, i) => {
    const next = merged[i + 1];
    const to = next ? dayBefore(next.from) : (endDate ?? (position.validTo ? dayBefore(position.validTo) : position.from));
    return { jobTitle: position.jobTitle, from: position.from, to };
  });
}

const AFTERNOON: Readonly<Record<DocumentLanguage, string>> = { fr: 'après-midi', ar: 'بعد الظهر' };

/**
 * Unicode bidi embedding, override and isolate controls (LRE RLE PDF LRO RLO, LRI RLI FSI PDI). The renderer applies
 * them: an unterminated RLO pasted into a name or a letterhead field would print the rest of the legal sentence
 * mirrored (names, dates, matricule). Templates lay out each value themselves, so these characters never carry
 * meaning in a document; the marks LRM/RLM (U+200E/U+200F) are harmless and kept.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Every string of `value` (deeply) without {@link BIDI_CONTROLS}. */
export function withoutBidiControls<T>(value: T): T {
  if (typeof value === 'string') return value.replace(BIDI_CONTROLS, '') as T;
  if (Array.isArray(value)) return value.map((item: unknown) => withoutBidiControls(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutBidiControls(item)])) as T;
  }
  return value;
}

/** Builds the snapshot (number left empty: the issue use case sets it once allocated). */
export function buildSnapshot(input: SnapshotInput): DocumentSnapshot {
  const { lang, profile: p, employee: e } = input;
  const ar = lang === 'ar';
  const pick = (fr: string | null, arValue: string | null): string | null => (ar ? arValue : fr);
  const ids = (['nif', 'nis', 'rc', 'ai'] as const).flatMap((key) => {
    const value = p[key];
    return value ? [{ label: ID_LABELS[lang][key], value }] : [];
  });
  const snapshot: DocumentSnapshot = {
    v: 1,
    type: input.type,
    lang,
    number: '',
    issueDate: input.issueDate,
    issueDateText: dateText(input.issueDate, lang),
    company: {
      legalName: pick(p.legalNameFr, p.legalNameAr) ?? '',
      address: pick(p.addressFr, p.addressAr) ?? '',
      city: pick(p.cityFr, p.cityAr) ?? '',
      phone: p.phone,
      email: p.email,
      ids,
      footer: pick(p.footerFr, p.footerAr),
      hasLogo: p.hasLogo,
    },
    employee: {
      civility: civilityOf(e.sex, lang),
      sex: e.sex === 'M' || e.sex === 'F' ? e.sex : null,
      fullName: fullNameOf(e, lang),
      matricule: e.matricule,
      birthDateText: e.birthDate ? dateText(e.birthDate, lang) : null,
      birthPlace: e.birthDate ? e.birthPlace : null,
      jobTitle: e.jobTitle,
      unitName: ar ? (e.unitNameAr ?? e.unitName) : e.unitName,
      hireDateText: dateText(e.hireDate, lang),
      endDateText: e.endDate ? dateText(e.endDate, lang) : null,
    },
    signatory: { name: ar ? input.signatory.nameAr : input.signatory.nameFr, title: ar ? input.signatory.titleAr : input.signatory.titleFr },
    ref: { employmentId: e.employmentId, signatoryId: input.signatory.id },
  };
  if (input.type === 'certificat_travail') {
    snapshot.employee.positions = positionsOf(e.assignments, e.endDate).map((pos) => ({
      jobTitle: pos.jobTitle,
      fromText: dateText(pos.from, lang),
      toText: dateText(pos.to, lang),
    }));
  }
  if (input.type === 'titre_conge' && input.leave) {
    const l = input.leave;
    const start = dateText(l.startDate, lang);
    const resumption = dateText(l.resumption.date, lang);
    snapshot.leave = {
      typeLabel: ar ? l.typeLabels.ar : l.typeLabels.fr,
      startText: l.halfDayStart ? `${start} (${AFTERNOON[lang]})` : start,
      endText: dateText(l.endDate, lang),
      days: daysText(l.days, lang),
      halfDayStart: l.halfDayStart,
      halfDayEnd: l.halfDayEnd,
      resumptionText: l.resumption.afternoon ? `${resumption} ${AFTERNOON[lang]}` : resumption,
    };
    snapshot.ref.leaveRequestId = l.requestId;
  }
  // the stored snapshot is exactly what is printed: bidi controls are removed from every value
  return withoutBidiControls(snapshot);
}
