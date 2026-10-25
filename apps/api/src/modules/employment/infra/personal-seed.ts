/*
 * Personal details: per-company defaults (bootstrap, seed:dev, test fixtures) and the demo company's contact, emergency
 * and family data (docs/contracts/profile-changes.md › Seed).
 *
 *   !!! TEST DATA — fictitious !!!  Phones (`+213 555 …`), e-mail addresses (domain `exemple.test`), addresses and
 *   children's first names are INVENTED by a deterministic generator and match no real person.
 *
 * Runs as the MIGRATOR (owner, BYPASSRLS): company_id is written explicitly. Idempotent (`on conflict do nothing`,
 * fixed child ids).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { seedWorkflowDefinitions, type SeedDefinition } from '../../workflow/index.js';
import type { SeedEmployee } from './demo-employees.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Codes of the request approval chains (migration 0025 for existing companies). */
export const PROFILE_WORKFLOW_CODES = { hr: 'profile.hr', bank: 'profile.bank' } as const;

export const PROFILE_DEFINITIONS: readonly SeedDefinition[] = [
  {
    code: PROFILE_WORKFLOW_CODES.hr,
    names: { fr: 'Modification du profil (RH)', ar: 'تعديل الملف الشخصي (الموارد البشرية)', en: 'Profile change (HR)' },
    steps: [{ key: 'hr', kind: 'permission', permission: 'employee.personal.update', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } }],
  },
  {
    code: PROFILE_WORKFLOW_CODES.bank,
    names: { fr: 'Modification des coordonnées bancaires', ar: 'تعديل المعلومات البنكية', en: 'Bank details change' },
    steps: [{ key: 'hr', kind: 'permission', permission: 'employee.bank.update', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } }],
  },
];

/**
 * Defaults of a new company: the two approval chains and the policy row with the column defaults (contact and
 * emergency contact immediate, family on approval, files kept 30 days). The `supporting_document` file category comes
 * with seedDocumentDefaults (SYSTEM_FILE_CATEGORIES).
 */
export async function seedProfileDefaults(db: Executor, companyId: string): Promise<void> {
  await seedWorkflowDefinitions(db, companyId, PROFILE_DEFINITIONS);
  await sql`insert into profile_policy (company_id) values (${companyId}::uuid) on conflict do nothing`.execute(db);
}

// ── demo data ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The demo sites' wilaya codes, communes and postal codes. */
const PLACE_BY_SITE: Record<string, { wilaya: string; commune: string; postal: string }> = {
  'ALG-HQ': { wilaya: '16', commune: 'Hydra', postal: '16035' },
  'ALG-CTR': { wilaya: '16', commune: 'Alger-Centre', postal: '16000' },
  BLIDA: { wilaya: '09', commune: 'Blida', postal: '09000' },
  CNE: { wilaya: '25', commune: 'Constantine', postal: '25000' },
  ANNABA: { wilaya: '23', commune: 'Annaba', postal: '23000' },
  ORAN: { wilaya: '31', commune: 'Oran', postal: '31000' },
  TLEMCEN: { wilaya: '13', commune: 'Tlemcen', postal: '13000' },
};

const STREETS = ['Rue des Frères Bouadou', 'Cité 500 Logements, Bât. B', 'Boulevard de l’ALN', 'Rue Larbi Ben M’hidi', 'Cité El Bahia, Bloc 12', 'Lotissement Les Oliviers'];
const CHILD_NAMES: readonly [string, 'M' | 'F'][] = [
  ['Adam', 'M'], ['Lina', 'F'], ['Rayan', 'M'], ['Inès', 'F'], ['Youcef', 'M'], ['Maria', 'F'], ['Anis', 'M'], ['Sirine', 'F'],
];
const EMERGENCY_FIRST = ['Samir', 'Malika', 'Karim', 'Naima', 'Hakim', 'Dalila'];
const RELATIONSHIPS = ['spouse', 'parent', 'sibling', 'other'] as const;

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const childId = (n: number, k: number) => `0190a5d0-0000-7000-8e01-${(n * 16 + k).toString(16).padStart(12, '0')}`;
const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toLowerCase();

/** The site code of a demo unit: its own, else the nearest ancestor's. */
function siteOfUnit(unitId: string): string | undefined {
  const units = DEMO_ORGANIZATION.units;
  let unit = units.find((u) => u.id === unitId);
  while (unit) {
    if (unit.site) return unit.site;
    const parent = unit.parent;
    unit = parent ? units.find((u) => u.code === parent) : undefined;
  }
  return undefined;
}

/**
 * Contact, emergency contact and family of most demo employees (every seventh has none: « non renseigné » screens);
 * children for some married ones. Returns how many persons got data.
 */
export async function seedDemoPersonal(db: Executor, companyId: string, employees: readonly SeedEmployee[]): Promise<number> {
  let seeded = 0;
  for (const [i, e] of employees.entries()) {
    const n = i + 1;
    if (n % 7 === 0) continue;
    seeded += 1;
    const unitId = e.assignments.at(-1)?.orgUnitId ?? e.assignments[0]?.orgUnitId ?? '';
    const place = PLACE_BY_SITE[siteOfUnit(unitId) ?? 'ALG-HQ'] ?? { wilaya: '16', commune: 'Alger-Centre', postal: '16000' };
    // TEST DATA — fictitious
    await sql`
      insert into person_contact (person_id, company_id, mobile_phone, other_phone, personal_email, address_line, commune, wilaya_code, postal_code)
      values (${e.personId}::uuid, ${companyId}::uuid, ${`+213555${pad(100000 + n * 137, 6)}`}, ${n % 3 === 0 ? `+213661${pad(200000 + n * 71, 6)}` : null},
              ${n % 4 === 0 ? null : `${ascii(e.firstName)}.${ascii(e.lastName)}${n}@exemple.test`},
              ${`${(n % 40) + 1}, ${STREETS[n % STREETS.length] ?? STREETS[0]}`}, ${place.commune}, ${place.wilaya}, ${place.postal})
      on conflict do nothing`.execute(db);
    if (n % 4 !== 3) {
      const relationship = RELATIONSHIPS[n % RELATIONSHIPS.length] ?? 'other';
      await sql`
        insert into person_emergency_contact (person_id, company_id, full_name, relationship, phone)
        values (${e.personId}::uuid, ${companyId}::uuid, ${`${EMERGENCY_FIRST[n % EMERGENCY_FIRST.length] ?? 'Samir'} ${e.lastName}`}, ${relationship},
                ${`+213555${pad(900000 - n * 113, 6)}`})
        on conflict do nothing`.execute(db);
    }
    const birthYear = Number(e.birthDate.slice(0, 4));
    const married = n % 3 !== 1 && birthYear <= 1995;
    const status = married ? 'married' : n % 11 === 0 ? 'divorced' : 'single';
    const since = status === 'single' ? null : `${birthYear + 26}-${pad((n % 12) + 1, 2)}-15`;
    await sql`
      insert into person_family (person_id, company_id, marital_status, marital_status_since, spouse_employed)
      values (${e.personId}::uuid, ${companyId}::uuid, ${status}, ${since}::date, ${married ? (n % 2 === 0 ? 'yes' : 'no') : null})
      on conflict do nothing`.execute(db);
    if (married) {
      const count = n % 4; // 0–3 children
      for (let k = 0; k < count; k++) {
        const [firstName, sex] = CHILD_NAMES[(n + k) % CHILD_NAMES.length] ?? ['Adam', 'M'];
        const year = Math.min(birthYear + 28 + k * 3, 2025);
        await sql`
          insert into person_child (id, company_id, person_id, first_name, birth_date, sex, dependent)
          values (${childId(n, k)}::uuid, ${companyId}::uuid, ${e.personId}::uuid, ${firstName}, ${`${year}-${pad(((n + k) % 12) + 1, 2)}-${pad(((n * 3 + k) % 27) + 1, 2)}`}::date,
                  ${sex}, ${year >= 2005})
          on conflict do nothing`.execute(db);
      }
    }
  }
  return seeded;
}
