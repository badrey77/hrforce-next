import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { seedWorkflowDefinitions, SYSTEM_ACTOR_ID, type SeedDefinition } from '../../workflow/index.js';
import { addDays, addMonths, addYears, DECISION_WORKFLOW_CODE, type ContractKind, type ContractType } from '../domain/contracts.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** The decision chain of every company (migration 0023 for existing ones). */
export const CONTRACT_DEFINITIONS: readonly SeedDefinition[] = [
  {
    code: DECISION_WORKFLOW_CODE,
    names: { fr: 'Décision de fin de contrat', ar: 'قرار بشأن نهاية العقد', en: 'End-of-contract decision' },
    steps: [
      { key: 'manager', kind: 'manager', labels: { fr: 'Responsable', ar: 'المسؤول', en: 'Manager' } },
      { key: 'hr', kind: 'permission', permission: 'employee.contract.manage', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } },
    ],
  },
];

/** Defaults of a new company (bootstrap, seed:dev, test fixtures): the `contract.decision` workflow definition. */
export async function seedContractDefaults(db: Executor, companyId: string): Promise<void> {
  await seedWorkflowDefinitions(db, companyId, CONTRACT_DEFINITIONS);
}

/** One demo employment, as seed:dev knows it (Employment's demo list; passed in to keep this module below Employment). */
export interface DemoContractEmployee {
  employmentId: string;
  personId: string;
  matricule: string;
  hireDate: string;
  /** inclusive last day; null = open */
  endDate: string | null;
}

export interface SeedDemoContractsInput {
  companyId: string;
  /** Algiers date of the run: the demo deadlines are placed relative to it */
  today: string;
  employees: readonly DemoContractEmployee[];
  /** the user linked to the head of Agence Annaba (chef.annaba@demo.dz): the pending decision's manager step */
  annabaHeadUserId: string;
  /** the unit whose head approves (Agence Annaba) — the task's scope unit */
  annabaUnitId: string;
}

interface DemoContract {
  kind: ContractKind;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd?: string | null;
  reference?: string;
  reason?: string;
}

const fixed = (group: number, n: number) => `0190a5d0-0000-7000-8000-${group.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;

/**
 * DEMO contracts (docs/contracts/contracts-deadlines.md › Seed), relative to `today`:
 *   - a CDI from the hire date for nearly everyone;
 *   - EMP-0031 (Agence Annaba): a CDD ending in 20 days, with a PENDING decision at the manager step (chef.annaba);
 *   - EMP-0032 (Service Clientèle Annaba): a CDD that ended 3 days ago, still employed (critical);
 *   - EMP-0033 (Service Clientèle Annaba): a CDD converted to a CDI 60 days ago, probation ending in 10 days;
 *   - EMP-0019 (Agence Blida): a pré-emploi (DAIP) year, then a CDI;
 *   - EMP-0037 (Agence Oran): a CDD ending in 4 months (outside the notice windows);
 *   - EMP-0018 (Agence Alger Centre): no contract (« contrat non renseigné »);
 *   - EMP-0023 (Service Administration Est): turns 60 in 4 months (birth date moved; TEST DATA).
 * Idempotent: an employment that already has a contract is left as it is (the dates of the first run stay).
 */
export async function seedDemoContracts(db: Executor, input: SeedDemoContractsInput): Promise<{ contracts: number; decisions: number }> {
  const { companyId, today } = input;
  const plans = new Map<string, DemoContract[]>();
  for (const e of input.employees) {
    const lastDay = e.endDate;
    switch (e.matricule) {
      case 'EMP-0018':
        plans.set(e.employmentId, []);
        break;
      case 'EMP-0031':
        plans.set(e.employmentId, [{ kind: 'initial', contractType: 'cdd', startDate: e.hireDate, endDate: addDays(today, 20), reference: 'CDD-ANB-031', reason: 'Surcroît d’activité' }]);
        break;
      case 'EMP-0032':
        plans.set(e.employmentId, [{ kind: 'initial', contractType: 'cdd', startDate: e.hireDate, endDate: addDays(today, -3), reference: 'CDD-ANB-032', reason: 'Remplacement' }]);
        break;
      case 'EMP-0033':
        plans.set(e.employmentId, [
          { kind: 'initial', contractType: 'cdd', startDate: e.hireDate, endDate: addDays(today, -61), reference: 'CDD-ANB-033' },
          { kind: 'conversion', contractType: 'cdi', startDate: addDays(today, -60), endDate: null, probationEnd: addDays(today, 10), reference: 'CDI-ANB-033' },
        ]);
        break;
      case 'EMP-0019': {
        const preEnd = addDays(addYears(e.hireDate, 1), -1);
        plans.set(e.employmentId, [
          { kind: 'initial', contractType: 'pre_emploi', startDate: e.hireDate, endDate: preEnd, reference: 'DAIP-BLD-019', reason: 'Dispositif d’aide à l’insertion professionnelle' },
          { kind: 'conversion', contractType: 'cdi', startDate: addDays(preEnd, 1), endDate: null },
        ]);
        break;
      }
      case 'EMP-0037':
        plans.set(e.employmentId, [{ kind: 'initial', contractType: 'cdd', startDate: e.hireDate, endDate: addMonths(today, 4), reference: 'CDD-ORN-037' }]);
        break;
      default:
        plans.set(e.employmentId, [{ kind: 'initial', contractType: 'cdi', startDate: e.hireDate, endDate: null }]);
    }
    // a contract never starts after the employment's last day
    if (lastDay !== null) plans.set(e.employmentId, (plans.get(e.employmentId) ?? []).filter((c) => c.startDate <= lastDay));
  }

  let contracts = 0;
  let n = 0;
  for (const e of input.employees) {
    n += 1;
    const has = await sql<{ n: number }>`select count(*)::int as n from employment_contract where company_id = ${companyId}::uuid and employment_id = ${e.employmentId}::uuid`.execute(db);
    if ((has.rows[0]?.n ?? 0) > 0) continue;
    for (const [k, c] of (plans.get(e.employmentId) ?? []).entries()) {
      await sql`
        insert into employment_contract (id, company_id, employment_id, seq, kind, contract_type, start_date, end_date, probation_end, reference, reason)
        values (${fixed(0x0c0, n * 10 + k)}::uuid, ${companyId}::uuid, ${e.employmentId}::uuid, ${k + 1}, ${c.kind}, ${c.contractType},
                ${c.startDate}::date, ${c.endDate}::date, ${c.probationEnd ?? null}::date, ${c.reference ?? null}, ${c.reason ?? null})
        on conflict do nothing`.execute(db);
      contracts += 1;
    }
  }

  // EMP-0023 turns 60 in 4 months (retirement deadline). TEST DATA: only the birth date moves.
  const retiring = input.employees.find((e) => e.matricule === 'EMP-0023');
  if (retiring) {
    await sql`update person set birth_date = ${addYears(addMonths(today, 4), -60)}::date
               where company_id = ${companyId}::uuid and id = ${retiring.personId}::uuid`.execute(db);
  }

  // The pending decision about EMP-0031's CDD, at the manager step (chef.annaba).
  let decisions = 0;
  const target = input.employees.find((e) => e.matricule === 'EMP-0031');
  const definition = await db.selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', DECISION_WORKFLOW_CODE).executeTakeFirst();
  if (target && definition) {
    const contract = await sql<{ id: string }>`select id from employment_contract where company_id = ${companyId}::uuid and employment_id = ${target.employmentId}::uuid and seq = 1`.execute(db);
    const contractId = contract.rows[0]?.id;
    const decisionId = fixed(0x0c1, 1);
    const instanceId = fixed(0x0c1, 2);
    const exists = await sql<{ n: number }>`select count(*)::int as n from contract_decision where company_id = ${companyId}::uuid and id = ${decisionId}::uuid`.execute(db);
    if (contractId && (exists.rows[0]?.n ?? 0) === 0) {
      await sql`insert into contract_decision (id, company_id, employment_id, contract_id, status, opened_by)
                values (${decisionId}::uuid, ${companyId}::uuid, ${target.employmentId}::uuid, ${contractId}::uuid, 'pending', 'system')`.execute(db);
      await sql`
        insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, subject_user_id)
        values (${instanceId}::uuid, ${companyId}::uuid, ${definition.id}::uuid, 'contract_decision', ${decisionId}::uuid, 'pending', 0,
                ${SYSTEM_ACTOR_ID}::uuid, null)`.execute(db);
      await sql`
        insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, assignee_user_id, permission, scope_unit_id, status)
        values (${fixed(0x0c1, 3)}::uuid, ${companyId}::uuid, ${instanceId}::uuid, 'manager', 0, 'user', ${input.annabaHeadUserId}::uuid, null,
                ${input.annabaUnitId}::uuid, 'open')`.execute(db);
      await sql`update contract_decision set workflow_instance_id = ${instanceId}::uuid where company_id = ${companyId}::uuid and id = ${decisionId}::uuid`.execute(db);
      decisions = 1;
    }
  }
  return { contracts, decisions };
}
