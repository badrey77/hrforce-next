import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { parseSteps, type Labels, type StepDef } from '../domain/steps.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SeedDefinition {
  code: string;
  names: Labels;
  steps: StepDef[];
}

/** The system definitions of every company (docs/contracts/leave.md › Seed additions). */
export const SYSTEM_DEFINITIONS: readonly SeedDefinition[] = [
  {
    code: 'leave.manager_then_hr',
    names: { fr: 'Responsable puis RH', ar: 'المسؤول المباشر ثم الموارد البشرية', en: 'Manager then HR' },
    steps: [
      { key: 'manager', kind: 'manager', labels: { fr: 'Responsable hiérarchique', ar: 'المسؤول المباشر', en: 'Line manager' } },
      { key: 'hr', kind: 'permission', permission: 'leave.approve_hr', labels: { fr: 'Ressources humaines', ar: 'الموارد البشرية', en: 'Human resources' } },
    ],
  },
  {
    code: 'leave.hr_only',
    names: { fr: 'RH uniquement', ar: 'الموارد البشرية فقط', en: 'HR only' },
    steps: [{ key: 'hr', kind: 'permission', permission: 'leave.approve_hr', labels: { fr: 'Ressources humaines', ar: 'الموارد البشرية', en: 'Human resources' } }],
  },
];

/** Idempotently creates the system definitions of a company (existing codes are left untouched). Returns code → id. */
export async function seedWorkflowDefinitions(db: Executor, companyId: string, definitions: readonly SeedDefinition[] = SYSTEM_DEFINITIONS): Promise<Map<string, string>> {
  for (const d of definitions) {
    parseSteps(d.steps);
    await sql`
      insert into workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
      values (${companyId}::uuid, ${d.code}, ${d.names.fr}, ${d.names.ar}, ${d.names.en}, ${JSON.stringify(d.steps)}::jsonb, true)
      on conflict (company_id, code) do nothing`.execute(db);
  }
  const rows = await db.selectFrom('workflow_definition').select(['id', 'code']).where('company_id', '=', companyId).execute();
  return new Map(rows.map((r) => [r.code, r.id]));
}
