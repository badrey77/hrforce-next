/*
 * Demo employees for `seed:dev` and the e2e suites (docs/contracts/employment.md › Seed).
 *
 *   !!! TEST DATA — fictitious !!!  Every person, name combination, NIN, NSS and RIB below is INVENTED by a
 *   deterministic generator (the identifiers carry the "99" / "0079999" test markers and match no real person or
 *   account). Never load this into a production database (seed:dev refuses NODE_ENV=production).
 *
 * Runs as the MIGRATOR (owner, BYPASSRLS): company_id is written explicitly. Idempotent: fixed ids, `on conflict do
 * nothing`. The deferred date checks of migration 0010 run at the commit of the seeding transaction.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { addDays, type EndReason } from '../domain/employee.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SeedAssignment {
  id: string;
  orgUnitId: string;
  siteId?: string | null;
  jobTitle: string;
  validFrom: string;
  /** exclusive end (null = open) */
  validTo: string | null;
}

export interface SeedSalary {
  id: string;
  baseSalary: string;
  validFrom: string;
  validTo: string | null;
}

export interface SeedEmployee {
  personId: string;
  employmentId: string;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  sex: 'M' | 'F';
  birthDate: string;
  birthPlace: string;
  /** TEST DATA — fictitious */
  nin: string;
  /** TEST DATA — fictitious */
  nss: string | null;
  /** TEST DATA — fictitious */
  rib: string | null;
  bankName: string | null;
  matricule: string;
  hireDate: string;
  endDate: string | null;
  endReason: EndReason | null;
  assignments: SeedAssignment[];
  salaries: SeedSalary[];
}

const hex = (n: number, width = 12) => n.toString(16).padStart(width, '0');
/** Fixed ids: persons …-8001-…, employments …-8002-…, assignments …-8003-…, salaries …-8004-… (+ a per-company offset). */
const fixedId = (kind: number, n: number) => `0190a5d0-0000-7000-${8000 + kind}-${hex(n)}`;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

// Common Algerian first / last names, Latin + Arabic spelling. Combinations are arbitrary (fictitious people).
const MALE: readonly [string, string][] = [
  ['Mohamed', 'محمد'], ['Ahmed', 'أحمد'], ['Yacine', 'ياسين'], ['Sofiane', 'سفيان'], ['Mourad', 'مراد'],
  ['Rachid', 'رشيد'], ['Nassim', 'نسيم'], ['Walid', 'وليد'], ['Amine', 'أمين'], ['Bilal', 'بلال'],
  ['Hichem', 'هشام'], ['Farid', 'فريد'], ['Djamel', 'جمال'], ['Omar', 'عمر'], ['Khaled', 'خالد'],
  ['Redouane', 'رضوان'], ['Mustapha', 'مصطفى'], ['Abdelkader', 'عبد القادر'], ['Riad', 'رياض'], ['Fouad', 'فؤاد'],
];
const FEMALE: readonly [string, string][] = [
  ['Fatima', 'فاطمة'], ['Meriem', 'مريم'], ['Nadia', 'نادية'], ['Sarah', 'سارة'], ['Yasmine', 'ياسمين'],
  ['Lamia', 'لمياء'], ['Khadidja', 'خديجة'], ['Souad', 'سعاد'], ['Imane', 'إيمان'], ['Leïla', 'ليلى'],
  ['Houda', 'هدى'], ['Asma', 'أسماء'], ['Karima', 'كريمة'], ['Wafa', 'وفاء'], ['Hanane', 'حنان'],
  ['Zineb', 'زينب'], ['Rym', 'ريم'], ['Nour', 'نور'], ['Chahrazed', 'شهرزاد'], ['Hayet', 'حياة'],
];
const LAST: readonly [string, string][] = [
  ['Benali', 'بن علي'], ['Haddad', 'حداد'], ['Bouzid', 'بوزيد'], ['Mansouri', 'منصوري'], ['Saïdi', 'سعيدي'],
  ['Boudiaf', 'بوضياف'], ['Cherif', 'شريف'], ['Hamidi', 'حميدي'], ['Khelifi', 'خليفي'], ['Meziane', 'مزيان'],
  ['Rahmani', 'رحماني'], ['Zerrouki', 'زروقي'], ['Djebbar', 'جبار'], ['Bensalem', 'بن سالم'], ['Brahimi', 'براهيمي'],
  ['Aouadi', 'عوادي'], ['Kaci', 'قاسي'], ['Lounis', 'لونيس'], ['Taleb', 'طالب'], ['Ferhat', 'فرحات'],
  ['Amrani', 'عمراني'], ['Slimani', 'سليماني'], ['Touati', 'تواتي'], ['Guerfi', 'قرفي'], ['Belaïd', 'بلعيد'],
];
const PLACES = ['Alger', 'Oran', 'Constantine', 'Annaba', 'Blida', 'Tlemcen', 'Sétif', 'Béjaïa', 'Tizi Ouzou', 'Batna'];
const BANKS = ['BNA', 'CPA', 'BADR', 'BDL', 'CNEP-Banque', 'BEA'];

const JOBS: Record<string, readonly string[]> = {
  direction_generale: ['Directeur général', 'Assistante de direction'],
  department: ['Directeur de département'],
  region: ['Directeur régional'],
  agency: ['Chef d’agence', 'Chargé de clientèle', 'Conseiller commercial', 'Caissier'],
  service: ['Chef de service', 'Gestionnaire', 'Agent administratif'],
};

/** Demo staffing: unit code → head count (40 in all; 12 end up in Région Est, 7 in Région Ouest). */
const STAFFING: readonly [string, number][] = [
  ['DG', 2], ['DEP-RH', 1], ['SRV-PAIE', 3], ['SRV-FORM', 2], ['DEP-FIN', 1], ['SRV-COMPTA', 3], ['DEP-RX', 1],
  ['REG-CTR', 1], ['AG-ALG', 4], ['AG-BLIDA', 3],
  ['REG-EST', 1], ['SRV-ADM-EST', 2], ['AG-CNE', 4], ['AG-ANNABA', 3], ['SRV-CLI-ANB', 2],
  ['REG-OUEST', 1], ['AG-ORAN', 4], ['AG-TLEMCEN', 2],
];

/** Moves (assignment history): employee index → earlier unit and the date of the move to the staffed unit. */
const MOVES: Record<number, { from: string; on: string }> = {
  28: { from: 'AG-CNE', on: '2026-04-01' }, // Constantine → Annaba (Région Est)
  38: { from: 'AG-ORAN', on: '2025-09-01' }, // Oran → Tlemcen (Région Ouest)
  14: { from: 'AG-BLIDA', on: '2026-02-15' }, // Blida → Alger Centre (Région Centre)
};

/** Ended employments: employee index → last day worked (inclusive) and reason. */
const ENDS: Record<number, { on: string; reason: EndReason }> = {
  24: { on: '2026-06-30', reason: 'resignation' }, // Agence Constantine
  39: { on: '2026-03-31', reason: 'retirement' }, // Agence Tlemcen
};

/** The 40 demo employees of the DEMO company (deterministic). */
export function demoEmployees(): SeedEmployee[] {
  const units = new Map(DEMO_ORGANIZATION.units.map((u) => [u.code, u]));
  const slots = STAFFING.flatMap(([code, count]) => Array.from({ length: count }, (_, k) => ({ code, k })));
  return slots.map(({ code, k }, i) => {
    const n = i + 1;
    const unit = units.get(code);
    if (!unit) throw new Error(`demo employees: unknown unit ${code}`);
    const sex = i % 2 === 0 ? 'M' : 'F';
    const [firstName, firstNameAr] = (sex === 'M' ? MALE : FEMALE)[(i * 7) % 20] ?? ['Ali', 'علي'];
    const [lastName, lastNameAr] = LAST[(i * 11) % LAST.length] ?? ['Ali', 'علي'];
    // a few people without an Arabic spelling (the Arabic names are optional)
    const noArabic = n % 13 === 0;
    const birthYear = 1965 + ((i * 7) % 33);
    const hireDate = `${2008 + ((i * 3) % 18)}-${pad(((i * 5) % 12) + 1, 2)}-${pad(((i * 7) % 27) + 1, 2)}`;
    const jobs = JOBS[unit.kind] ?? ['Agent'];
    const move = MOVES[i];
    const end = ENDS[i] ?? null;
    const endValidTo = end ? addDays(end.on, 1) : null;
    const assignments: SeedAssignment[] = move
      ? [
          { id: fixedId(3, n * 2), orgUnitId: units.get(move.from)?.id ?? '', jobTitle: 'Chargé de clientèle', validFrom: hireDate, validTo: move.on },
          { id: fixedId(3, n * 2 + 1), orgUnitId: unit.id, jobTitle: jobs[k % jobs.length] ?? 'Agent', validFrom: move.on, validTo: endValidTo },
        ]
      : [{ id: fixedId(3, n * 2), orgUnitId: unit.id, jobTitle: jobs[k % jobs.length] ?? 'Agent', validFrom: hireDate, validTo: endValidTo }];
    const base = 42000 + ((i * 3700) % 96000);
    // a raise on 2026-01-01 for every third employee (salary history)
    const raise = i % 3 === 0 && hireDate < '2026-01-01' && (!end || end.on >= '2026-01-01');
    const salaries: SeedSalary[] = raise
      ? [
          { id: fixedId(4, n * 2), baseSalary: `${base}.00`, validFrom: hireDate, validTo: '2026-01-01' },
          { id: fixedId(4, n * 2 + 1), baseSalary: `${Math.round(base * 1.08)}.50`, validFrom: '2026-01-01', validTo: endValidTo },
        ]
      : [{ id: fixedId(4, n * 2), baseSalary: `${base}.00`, validFrom: hireDate, validTo: endValidTo }];
    return {
      personId: fixedId(1, n),
      employmentId: fixedId(2, n),
      lastName,
      firstName,
      lastNameAr: noArabic ? null : lastNameAr,
      firstNameAr: noArabic ? null : firstNameAr,
      sex,
      birthDate: `${birthYear}-${pad(((i * 5) % 12) + 1, 2)}-${pad(((i * 11) % 28) + 1, 2)}`,
      birthPlace: PLACES[i % PLACES.length] ?? 'Alger',
      // TEST DATA — fictitious: 18 digits = sex digit + 2-digit birth year + "99" test marker + 13-digit sequence
      nin: `${sex === 'M' ? 1 : 2}${String(birthYear).slice(2)}99${pad(n, 13)}`,
      // TEST DATA — fictitious: "99" + 10 digits (12-digit NSS)
      nss: n % 9 === 0 ? null : `99${pad(n, 10)}`,
      // TEST DATA — fictitious: bank code 007 + "99999" test agency + 12-digit account (20 digits)
      rib: n % 5 === 0 ? null : `00799999${pad(n, 12)}`,
      bankName: n % 5 === 0 ? null : (BANKS[i % BANKS.length] ?? 'BNA'),
      matricule: `EMP-${pad(n, 4)}`,
      hireDate,
      endDate: end?.on ?? null,
      endReason: end?.reason ?? null,
      assignments,
      salaries,
    };
  });
}

/** Idempotently inserts persons, sensitive rows, employments, assignments and salaries of one company. */
export async function seedEmployees(db: Executor, companyId: string, employees: readonly SeedEmployee[]): Promise<void> {
  for (const e of employees) {
    await sql`
      insert into person (id, company_id, last_name, first_name, last_name_ar, first_name_ar, birth_date, birth_place, sex, nationality, nin)
      values (${e.personId}::uuid, ${companyId}::uuid, ${e.lastName}, ${e.firstName}, ${e.lastNameAr}, ${e.firstNameAr},
              ${e.birthDate}::date, ${e.birthPlace}, ${e.sex}, 'DZ', ${e.nin})
      on conflict do nothing`.execute(db);
    if (e.nss !== null || e.rib !== null) {
      await sql`
        insert into person_sensitive (person_id, company_id, nss, rib, bank_name)
        values (${e.personId}::uuid, ${companyId}::uuid, ${e.nss}, ${e.rib}, ${e.bankName})
        on conflict do nothing`.execute(db);
    }
    await sql`
      insert into employment (id, company_id, person_id, matricule, hire_date, end_date, end_reason)
      values (${e.employmentId}::uuid, ${companyId}::uuid, ${e.personId}::uuid, ${e.matricule}, ${e.hireDate}::date,
              ${e.endDate}::date, ${e.endReason})
      on conflict do nothing`.execute(db);
    for (const a of e.assignments) {
      await sql`
        insert into assignment (id, company_id, employment_id, org_unit_id, site_id, job_title, valid)
        values (${a.id}::uuid, ${companyId}::uuid, ${e.employmentId}::uuid, ${a.orgUnitId}::uuid, ${a.siteId ?? null}::uuid,
                ${a.jobTitle}, daterange(${a.validFrom}::date, ${a.validTo}::date, '[)'))
        on conflict do nothing`.execute(db);
    }
    for (const s of e.salaries) {
      await sql`
        insert into employment_salary (id, company_id, employment_id, base_salary, currency, valid)
        values (${s.id}::uuid, ${companyId}::uuid, ${e.employmentId}::uuid, ${s.baseSalary}::numeric, 'DZD',
                daterange(${s.validFrom}::date, ${s.validTo}::date, '[)'))
        on conflict do nothing`.execute(db);
    }
  }
}

/** The demo company's 40 employees (idempotent; the organisation must exist). */
export async function seedDemoEmployees(db: Executor): Promise<number> {
  const employees = demoEmployees();
  await seedEmployees(db, DEMO_ORGANIZATION.company.id, employees);
  return employees.length;
}
