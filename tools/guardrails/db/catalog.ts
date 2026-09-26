/**
 * Pure checks over a snapshot of a migrated database's catalog (loaded by loadCatalog):
 *  - company-id: every table in schema public has `company_id uuid not null`, ENABLE + FORCE row level security
 *    and at least one policy keyed on current_setting('app.company_id') — unless exempt
 *    (tools/guardrails/company-id-exempt.json: [{ table, reason, rls? }]; `rls: true` still requires RLS + policy;
 *    stale or malformed entries fail). Schema-qualified entries (e.g. `auth.user_account`) document tables of other
 *    schemas, which the check does not cover; they only have to exist.
 *  - audit-per-write: every tenant table of schema public (it has a `company_id` column, plus `company` itself) has an
 *    audit trigger — a trigger named `audit%`, AFTER … FOR EACH ROW, firing on INSERT, UPDATE and DELETE — unless
 *    listed with a reason in tools/guardrails/audit-exempt.json ([{ table, reason }]); stale entries (unknown or
 *    non-tenant table) and malformed ones fail. (Replaces the retired `-- @audited` migration marker.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';
import type { Violation } from '../lib/report.ts';

export const EXEMPT_FILE = 'tools/guardrails/company-id-exempt.json';
export const AUDIT_EXEMPT_FILE = 'tools/guardrails/audit-exempt.json';
export const TENANT_SETTING = 'app.company_id';
/** The tenant table itself: no company_id column (its id is the company id), audited like every tenant table. */
export const COMPANY_TABLE = 'company';

export type TriggerEvent = 'insert' | 'update' | 'delete' | 'truncate';

export interface TriggerInfo {
  name: string;
  /** function name (unqualified) */
  function: string;
  /** schema of the function (optional in hand-written test catalogs) */
  functionSchema?: string;
  /** FOR EACH ROW (false = statement) — optional in hand-written test catalogs, defaults to true */
  row?: boolean;
  /** BEFORE / AFTER / INSTEAD OF — optional in hand-written test catalogs, defaults to 'after' */
  timing?: 'before' | 'after' | 'instead';
  /** optional in hand-written test catalogs, defaults to all three row events */
  events?: TriggerEvent[];
}

export interface TableInfo {
  name: string;
  companyIdType: string | null; // null = no company_id column
  companyIdNotNull: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  policies: { name: string; using: string | null; withCheck: string | null }[];
  triggers: TriggerInfo[];
}

export interface ExemptEntry {
  table: string;
  reason: string;
  /** The table has no company_id but must still enforce RLS (e.g. `company`, isolated on its own id). */
  rls?: boolean;
}

export interface MigrationTable {
  table: string;
  file: string;
  line: number;
}

export interface AuditExemptEntry {
  table: string;
  reason: string;
}

/** pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h). */
const TG = { row: 1, before: 2, insert: 4, delete: 8, update: 16, truncate: 32, instead: 64 } as const;

export function decodeTriggerType(tgtype: number): Pick<TriggerInfo, 'row' | 'timing' | 'events'> {
  const events: TriggerEvent[] = [];
  if (tgtype & TG.insert) events.push('insert');
  if (tgtype & TG.update) events.push('update');
  if (tgtype & TG.delete) events.push('delete');
  if (tgtype & TG.truncate) events.push('truncate');
  return {
    row: (tgtype & TG.row) !== 0,
    timing: tgtype & TG.instead ? 'instead' : tgtype & TG.before ? 'before' : 'after',
    events,
  };
}

export async function loadCatalog(client: Client, schema = 'public'): Promise<TableInfo[]> {
  const { rows } = await client.query<{
    name: string;
    company_id_type: string | null;
    company_id_not_null: boolean | null;
    rls: boolean;
    force_rls: boolean;
    policies: { name: string; using: string | null; withCheck: string | null }[];
    triggers: { name: string; function: string; functionSchema: string; tgtype: number }[];
  }>(
    `select c.relname as name,
            format_type(a.atttypid, a.atttypmod) as company_id_type,
            a.attnotnull as company_id_not_null,
            c.relrowsecurity as rls,
            c.relforcerowsecurity as force_rls,
            coalesce((select json_agg(json_build_object('name', p.polname,
                                                        'using', pg_get_expr(p.polqual, p.polrelid),
                                                        'withCheck', pg_get_expr(p.polwithcheck, p.polrelid))
                                      order by p.polname)
                      from pg_policy p where p.polrelid = c.oid), '[]') as policies,
            coalesce((select json_agg(json_build_object('name', t.tgname, 'function', f.proname,
                                                        'functionSchema', fn.nspname, 'tgtype', t.tgtype)
                                      order by t.tgname)
                      from pg_trigger t
                      join pg_proc f on f.oid = t.tgfoid
                      join pg_namespace fn on fn.oid = f.pronamespace
                      where t.tgrelid = c.oid and not t.tgisinternal), '[]') as triggers
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
      where n.nspname = $1 and c.relkind in ('r', 'p')
      order by c.relname`,
    [schema],
  );
  return rows.map((r) => ({
    name: r.name,
    companyIdType: r.company_id_type,
    companyIdNotNull: r.company_id_not_null ?? false,
    rowSecurity: r.rls,
    forceRowSecurity: r.force_rls,
    policies: r.policies,
    triggers: r.triggers.map((t) => ({ name: t.name, function: t.function, functionSchema: t.functionSchema, ...decodeTriggerType(t.tgtype) })),
  }));
}

/** Captures [schema?, table]; tables outside `public` are reported schema-qualified (e.g. `auth.user_account`). */
const CREATE_TABLE =
  /^\s*create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?/i;

/** Tables created by the migrations (file:line of their CREATE TABLE). */
export function parseMigrationTables(root: string, dir: string): MigrationTable[] {
  const out: MigrationTable[] = [];
  let files: string[];
  try {
    files = readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.sql')).toSorted();
  } catch {
    return out;
  }
  for (const file of files) {
    const lines = readFileSync(path.join(root, dir, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      const match = CREATE_TABLE.exec(text);
      if (match?.[2]) {
        const schema = match[1]?.toLowerCase();
        const name = match[2].toLowerCase();
        const table = schema && schema !== 'public' ? `${schema}.${name}` : name;
        out.push({ table, file: `${dir}/${file}`, line: index + 1 });
      }
    });
  }
  return out;
}

export function loadExempt(root: string, file = EXEMPT_FILE): { entries: ExemptEntry[]; violations: Violation[] } {
  const violations: Violation[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    return { entries: [], violations: [{ file, rule: 'company-id/exempt', message: `cannot read: ${(error as Error).message}` }] };
  }
  if (!Array.isArray(raw)) return { entries: [], violations: [{ file, rule: 'company-id/exempt', message: 'must be a JSON array of {table, reason}' }] };
  const entries: ExemptEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const e = item as Partial<ExemptEntry>;
    if (typeof e.table !== 'string' || typeof e.reason !== 'string' || !e.reason.trim() || (e.rls !== undefined && typeof e.rls !== 'boolean')) {
      violations.push({ file, rule: 'company-id/exempt', message: `entry ${index} must be {table: string, reason: non-empty string, rls?: boolean}` });
      return;
    }
    if (seen.has(e.table)) violations.push({ file, rule: 'company-id/exempt', message: `duplicate entry for "${e.table}"` });
    seen.add(e.table);
    entries.push(e as ExemptEntry);
  });
  return { entries, violations };
}

function locate(tables: MigrationTable[], table: string): { file: string; line?: number } {
  const hit = tables.find((t) => t.table === table);
  return hit ? { file: hit.file, line: hit.line } : { file: `(database) public.${table}` };
}

function hasTenantPolicy(t: TableInfo): boolean {
  return t.policies.some((p) => `${p.using ?? ''} ${p.withCheck ?? ''}`.includes(TENANT_SETTING));
}

export function evaluateCompanyId(
  catalog: TableInfo[],
  exempt: ExemptEntry[],
  migrationTables: MigrationTable[] = [],
  exemptFile = EXEMPT_FILE,
  /** schema-qualified names of the tables of the other checked schemas (e.g. `auth.user_account`) */
  otherSchemaTables: readonly string[] = [],
): Violation[] {
  const violations: Violation[] = [];
  const names = new Set([...catalog.map((t) => t.name), ...otherSchemaTables]);
  for (const e of exempt) {
    if (!names.has(e.table)) {
      violations.push({ file: exemptFile, rule: 'company-id/exempt', message: `stale entry: table "${e.table}" does not exist — remove it` });
    }
  }
  for (const t of catalog) {
    const exemption = exempt.find((e) => e.table === t.name);
    const where = { ...locate(migrationTables, t.name), rule: 'company-id' };
    if (!exemption) {
      if (t.companyIdType === null) {
        violations.push({ ...where, message: `table ${t.name} has no company_id column (add company_id uuid not null, or exempt it with a reason in ${exemptFile})` });
      } else {
        if (t.companyIdType !== 'uuid') violations.push({ ...where, message: `${t.name}.company_id must be uuid (is ${t.companyIdType})` });
        if (!t.companyIdNotNull) violations.push({ ...where, message: `${t.name}.company_id must be NOT NULL` });
      }
    }
    if (exemption && !exemption.rls) continue;
    if (!t.rowSecurity) violations.push({ ...where, message: `table ${t.name}: row level security is not enabled (alter table … enable row level security)` });
    if (!t.forceRowSecurity) violations.push({ ...where, message: `table ${t.name}: row level security is not forced (alter table … force row level security)` });
    if (t.policies.length === 0) {
      violations.push({ ...where, message: `table ${t.name} has no RLS policy` });
    } else if (!hasTenantPolicy(t)) {
      violations.push({ ...where, message: `table ${t.name}: no policy references current_setting('${TENANT_SETTING}')` });
    }
  }
  return violations;
}

export function loadAuditExempt(root: string, file = AUDIT_EXEMPT_FILE): { entries: AuditExemptEntry[]; violations: Violation[] } {
  const violations: Violation[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    return { entries: [], violations: [{ file, rule: 'audit-per-write/exempt', message: `cannot read: ${(error as Error).message}` }] };
  }
  if (!Array.isArray(raw)) return { entries: [], violations: [{ file, rule: 'audit-per-write/exempt', message: 'must be a JSON array of {table, reason}' }] };
  const entries: AuditExemptEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const e = item as Partial<AuditExemptEntry>;
    if (typeof e.table !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) {
      violations.push({ file, rule: 'audit-per-write/exempt', message: `entry ${index} must be {table: string, reason: non-empty string}` });
      return;
    }
    if (seen.has(e.table)) violations.push({ file, rule: 'audit-per-write/exempt', message: `duplicate entry for "${e.table}"` });
    seen.add(e.table);
    entries.push({ table: e.table, reason: e.reason });
  });
  return { entries, violations };
}

/** Tenant tables of public: a company_id column, or the company table itself. */
export function isTenantTable(t: TableInfo): boolean {
  return t.companyIdType !== null || t.name === COMPANY_TABLE;
}

/** An audit trigger: named audit%, AFTER … FOR EACH ROW on INSERT, UPDATE and DELETE. */
export function isAuditTrigger(tg: TriggerInfo): boolean {
  const events = tg.events ?? ['insert', 'update', 'delete'];
  return (
    /^audit/i.test(tg.name) &&
    (tg.row ?? true) &&
    (tg.timing ?? 'after') === 'after' &&
    events.includes('insert') &&
    events.includes('update') &&
    events.includes('delete')
  );
}

export function evaluateAudited(
  catalog: TableInfo[],
  exempt: AuditExemptEntry[],
  migrationTables: MigrationTable[] = [],
  exemptFile = AUDIT_EXEMPT_FILE,
): Violation[] {
  const violations: Violation[] = [];
  const tenants = catalog.filter(isTenantTable);
  for (const e of exempt) {
    const table = catalog.find((t) => t.name === e.table);
    if (!table) {
      violations.push({ file: exemptFile, rule: 'audit-per-write/exempt', message: `stale entry: table "${e.table}" does not exist — remove it` });
    } else if (!isTenantTable(table)) {
      violations.push({ file: exemptFile, rule: 'audit-per-write/exempt', message: `stale entry: table "${e.table}" is not a tenant table (no company_id) — remove it` });
    }
  }
  for (const t of tenants) {
    if (exempt.some((e) => e.table === t.name)) continue;
    if (t.triggers.some(isAuditTrigger)) continue;
    const near = t.triggers.find((tg) => /^audit/i.test(tg.name));
    violations.push({
      ...locate(migrationTables, t.name),
      rule: 'audit-per-write',
      message: near
        ? `table ${t.name}: trigger ${near.name} must be AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW (execute function audit.capture())`
        : `table ${t.name} has no audit trigger: add \`create trigger audit_capture_tg after insert or update or delete on public.${t.name} for each row execute function audit.capture()\`, or exempt it with a reason in ${exemptFile}`,
    });
  }
  return violations;
}
