import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { scopeAssignmentSql } from '../../staffing/index.js';
import type { AssignmentFacts, DocumentSnapshot, EmployeeFacts, ProfileFacts } from '../domain/snapshot.js';
import type { DocumentLanguage, DocumentTypeCode } from '../domain/types.js';

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function pgError(error: unknown): { code: string; constraint?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string') return undefined;
  return typeof constraint === 'string' ? { code, constraint } : { code };
}

export interface TypeRow {
  id: string;
  code: DocumentTypeCode;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  numberFormat: string;
  languages: DocumentLanguage[];
  selfService: boolean;
  defaultSignatoryId: string | null;
  active: boolean;
  sortOrder: number;
}

export type ProfileRow = ProfileFacts;

export interface ProfileInput {
  legalNameFr: string;
  legalNameAr: string | null;
  addressFr: string;
  addressAr: string | null;
  cityFr: string;
  cityAr: string | null;
  phone: string | null;
  email: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  ai: string | null;
  footerFr: string | null;
  footerAr: string | null;
}

export interface LogoRow {
  bytes: Buffer;
  mime: string;
  sha256: Buffer;
}

export interface SignatoryRow {
  id: string;
  orgUnitId: string | null;
  unitCode: string | null;
  unitName: string | null;
  unitNameAr: string | null;
  nameFr: string;
  nameAr: string;
  titleFr: string;
  titleAr: string;
  active: boolean;
}

export interface EmployeeRow extends EmployeeFacts {
  /** the employee's scope unit on the date asked (assignment valid then, else the last one) */
  unitId: string;
}

export interface DocumentRow {
  id: string;
  documentTypeId: string;
  typeCode: DocumentTypeCode;
  year: number;
  seq: number;
  number: string;
  language: DocumentLanguage;
  employmentId: string;
  leaveRequestId: string | null;
  documentRequestId: string | null;
  orgUnitId: string;
  signatoryId: string;
  templateVersion: string;
  renderer: string;
  sha256: string;
  sizeBytes: number;
  issueDate: string;
  issuedBy: string;
  issuedAt: string;
  clientRequestId: string | null;
  status: 'issued' | 'void';
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** the linked leave request's status (titre de congé) */
  leaveStatus: string | null;
}

export interface NewDocument {
  documentTypeId: string;
  typeCode: DocumentTypeCode;
  year: number;
  seq: number;
  number: string;
  language: DocumentLanguage;
  employmentId: string;
  leaveRequestId: string | null;
  documentRequestId: string | null;
  orgUnitId: string;
  signatoryId: string;
  snapshot: DocumentSnapshot;
  templateVersion: string;
  renderer: string;
  sha256: Buffer;
  sizeBytes: number;
  issueDate: string;
  issuedBy: string;
  clientRequestId: string | null;
}

export interface RegisterFilter {
  scope: UnitIdQuery;
  today: string;
  typeCode?: string | undefined;
  status?: 'issued' | 'void' | undefined;
  employmentId?: string | undefined;
  leaveRequestId?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits?: boolean;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

export interface RequestRow {
  id: string;
  employmentId: string;
  documentTypeId: string;
  typeCode: DocumentTypeCode;
  language: DocumentLanguage;
  purpose: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: string;
  requestedAt: string;
  workflowInstanceId: string | null;
  issuedDocumentId: string | null;
  issuedNumber: string | null;
}

const TS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TYPE_COLUMNS = sql`t.id, t.code, t.name_fr as "nameFr", t.name_ar as "nameAr", t.name_en as "nameEn", t.number_format as "numberFormat",
  t.languages, t.self_service as "selfService", t.default_signatory_id as "defaultSignatoryId", t.active, t.sort_order as "sortOrder"`;

const PROFILE_COLUMNS = sql`legal_name_fr as "legalNameFr", legal_name_ar as "legalNameAr", address_fr as "addressFr", address_ar as "addressAr",
  city_fr as "cityFr", city_ar as "cityAr", phone, email, nif, nis, rc, ai, footer_fr as "footerFr", footer_ar as "footerAr",
  (logo is not null) as "hasLogo"`;

const DOCUMENT_COLUMNS = sql`d.id, d.document_type_id as "documentTypeId", d.type_code as "typeCode", d.year, d.seq, d.number, d.language,
  d.employment_id as "employmentId", d.leave_request_id as "leaveRequestId", d.document_request_id as "documentRequestId",
  d.org_unit_id as "orgUnitId", d.signatory_id as "signatoryId", d.template_version as "templateVersion", d.renderer,
  encode(d.content_sha256, 'hex') as sha256, d.size_bytes as "sizeBytes", d.issue_date::text as "issueDate", d.issued_by as "issuedBy",
  ${TS('d.issued_at')} as "issuedAt", d.client_request_id as "clientRequestId", d.status, d.voided_by as "voidedBy",
  ${TS('d.voided_at')} as "voidedAt", d.void_reason as "voidReason",
  (select lr.status from leave_request lr where lr.company_id = d.company_id and lr.id = d.leave_request_id) as "leaveStatus"`;

const REQUEST_COLUMNS = sql`q.id, q.employment_id as "employmentId", q.document_type_id as "documentTypeId", t.code as "typeCode", q.language,
  q.purpose, q.status, q.requested_by as "requestedBy", ${TS('q.requested_at')} as "requestedAt",
  q.workflow_instance_id as "workflowInstanceId", q.issued_document_id as "issuedDocumentId",
  (select d.number from issued_document d where d.company_id = q.company_id and d.id = q.issued_document_id) as "issuedNumber"`;

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Documents data (docs/contracts/documents.md › Data) — through the request transaction (`currentTx()`), always
 * filtered by company; RLS is the backstop. No constructor dependency: the dev seed uses it inside `runWithContext`.
 */
@Injectable()
export class DocumentsRepository {
  // ── types and counters ──────────────────────────────────────────────────────────────────────────────────────────

  async types(companyId: string): Promise<TypeRow[]> {
    const { rows } = await sql<TypeRow>`select ${TYPE_COLUMNS} from document_type t where t.company_id = ${companyId}::uuid
      order by t.sort_order, t.code`.execute(currentTx());
    return rows;
  }

  async type(companyId: string, id: string): Promise<TypeRow | undefined> {
    return (await this.types(companyId)).find((t) => t.id === id);
  }

  async typeByCode(companyId: string, code: string): Promise<TypeRow | undefined> {
    return (await this.types(companyId)).find((t) => t.code === code);
  }

  async updateType(companyId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await currentTx().updateTable('document_type').set(patch).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  /** Counter of each type for `year` (absent = no number yet). */
  async lastValues(companyId: string, year: number): Promise<Map<string, number>> {
    const rows = await currentTx()
      .selectFrom('document_sequence')
      .select(['document_type_id', 'last_value'])
      .where('company_id', '=', companyId)
      .where('year', '=', year)
      .execute();
    return new Map(rows.map((r) => [r.document_type_id, r.last_value]));
  }

  /**
   * Allocates the next number of (type, year) — ADR 008 §6: an upsert whose row lock is held until the transaction
   * ends, so concurrent issuers queue here and a rollback gives the number back. Waits at most 5 s (then 55P03).
   */
  async allocate(companyId: string, typeId: string, year: number): Promise<number> {
    const tx = currentTx();
    await sql`set local lock_timeout = '5s'`.execute(tx);
    const { rows } = await sql<{ last_value: number }>`
      insert into document_sequence (company_id, document_type_id, year, last_value)
      values (${companyId}::uuid, ${typeId}::uuid, ${year}, 1)
      on conflict (company_id, document_type_id, year) do update set last_value = document_sequence.last_value + 1
      returning last_value`.execute(tx);
    await sql`set local lock_timeout = 0`.execute(tx);
    const value = rows[0]?.last_value;
    if (value === undefined) throw new Error('document_sequence: no value returned');
    return value;
  }

  /** Serialises replays of one client request id (transaction-scoped advisory lock). */
  async lockClientRequest(companyId: string, clientRequestId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`document:${companyId}:${clientRequestId}`}, 0))`.execute(currentTx());
  }

  // ── profile ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async profile(companyId: string): Promise<ProfileRow | undefined> {
    const { rows } = await sql<ProfileRow>`select ${PROFILE_COLUMNS} from company_profile where company_id = ${companyId}::uuid`.execute(currentTx());
    return rows[0];
  }

  /** Upsert; unchanged values write nothing (no audit row). */
  async saveProfile(companyId: string, p: ProfileInput): Promise<void> {
    await sql`
      insert into company_profile (company_id, legal_name_fr, legal_name_ar, address_fr, address_ar, city_fr, city_ar, phone, email,
                                   nif, nis, rc, ai, footer_fr, footer_ar)
      values (${companyId}::uuid, ${p.legalNameFr}, ${p.legalNameAr}, ${p.addressFr}, ${p.addressAr}, ${p.cityFr}, ${p.cityAr}, ${p.phone},
              ${p.email}, ${p.nif}, ${p.nis}, ${p.rc}, ${p.ai}, ${p.footerFr}, ${p.footerAr})
      on conflict (company_id) do update set
        legal_name_fr = excluded.legal_name_fr, legal_name_ar = excluded.legal_name_ar, address_fr = excluded.address_fr,
        address_ar = excluded.address_ar, city_fr = excluded.city_fr, city_ar = excluded.city_ar, phone = excluded.phone,
        email = excluded.email, nif = excluded.nif, nis = excluded.nis, rc = excluded.rc, ai = excluded.ai,
        footer_fr = excluded.footer_fr, footer_ar = excluded.footer_ar, updated_at = now()
      where (company_profile.legal_name_fr, company_profile.legal_name_ar, company_profile.address_fr, company_profile.address_ar,
             company_profile.city_fr, company_profile.city_ar, company_profile.phone, company_profile.email, company_profile.nif,
             company_profile.nis, company_profile.rc, company_profile.ai, company_profile.footer_fr, company_profile.footer_ar)
        is distinct from (excluded.legal_name_fr, excluded.legal_name_ar, excluded.address_fr, excluded.address_ar, excluded.city_fr,
             excluded.city_ar, excluded.phone, excluded.email, excluded.nif, excluded.nis, excluded.rc, excluded.ai,
             excluded.footer_fr, excluded.footer_ar)`.execute(currentTx());
  }

  async logo(companyId: string): Promise<LogoRow | undefined> {
    const row = await currentTx()
      .selectFrom('company_profile')
      .select(['logo', 'logo_mime', 'logo_sha256'])
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!row?.logo || !row.logo_mime || !row.logo_sha256) return undefined;
    return { bytes: row.logo, mime: row.logo_mime, sha256: row.logo_sha256 };
  }

  /** Sets (or with null removes) the logo; creates an empty profile row when there is none yet. */
  async setLogo(companyId: string, logo: LogoRow | null): Promise<void> {
    await sql`
      insert into company_profile (company_id, logo, logo_mime, logo_sha256)
      values (${companyId}::uuid, ${logo?.bytes ?? null}, ${logo?.mime ?? null}, ${logo?.sha256 ?? null})
      on conflict (company_id) do update set logo = excluded.logo, logo_mime = excluded.logo_mime, logo_sha256 = excluded.logo_sha256,
        updated_at = now()
      where company_profile.logo_sha256 is distinct from excluded.logo_sha256`.execute(currentTx());
  }

  // ── signatories and units ───────────────────────────────────────────────────────────────────────────────────────

  async signatories(companyId: string, date: string): Promise<SignatoryRow[]> {
    const { rows } = await sql<SignatoryRow>`
      select s.id, s.org_unit_id as "orgUnitId", u.code as "unitCode", v.name as "unitName", v.name_ar as "unitNameAr",
             s.name_fr as "nameFr", s.name_ar as "nameAr", s.title_fr as "titleFr", s.title_ar as "titleAr", s.active
        from document_signatory s
        left join org_unit u on u.company_id = s.company_id and u.id = s.org_unit_id
        left join lateral (
          select vv.name, vv.name_ar from org_unit_version vv
           where vv.company_id = u.company_id and vv.org_unit_id = u.id
           order by (vv.valid @> ${date}::date) desc, lower(vv.valid) desc
           limit 1
        ) v on true
       where s.company_id = ${companyId}::uuid
       order by s.active desc, s.org_unit_id nulls first, s.name_fr, s.id`.execute(currentTx());
    return rows;
  }

  async insertSignatory(companyId: string, s: { orgUnitId: string | null; nameFr: string; nameAr: string; titleFr: string; titleAr: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('document_signatory')
      .values({ company_id: companyId, org_unit_id: s.orgUnitId, name_fr: s.nameFr, name_ar: s.nameAr, title_fr: s.titleFr, title_ar: s.titleAr })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updateSignatory(companyId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await currentTx().updateTable('document_signatory').set(patch).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async unitExists(companyId: string, unitId: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', unitId).executeTakeFirst();
    return row !== undefined;
  }

  /** The unit and its ancestors (today's tree) → distance from the unit (0 = itself). */
  async ancestorsOf(companyId: string, unitId: string): Promise<Map<string, number>> {
    const rows = await currentTx()
      .selectFrom('org_unit_closure')
      .select(['ancestor_id', 'depth'])
      .where('company_id', '=', companyId)
      .where('descendant_id', '=', unitId)
      .execute();
    const out = new Map(rows.map((r) => [r.ancestor_id, r.depth]));
    if (!out.has(unitId)) out.set(unitId, 0);
    return out;
  }

  // ── employees ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Person, employment, scope assignment (as of `date`) with its unit names, and every assignment. */
  async employee(companyId: string, employmentId: string, date: string): Promise<EmployeeRow | undefined> {
    const tx = currentTx();
    const { rows } = await sql<Omit<EmployeeRow, 'assignments'>>`
      select e.id as "employmentId", p.sex, p.first_name as "firstName", p.last_name as "lastName", p.first_name_ar as "firstNameAr",
             p.last_name_ar as "lastNameAr", e.matricule, p.birth_date::text as "birthDate", p.birth_place as "birthPlace",
             a.job_title as "jobTitle", coalesce(v.name, u.code) as "unitName", v.name_ar as "unitNameAr",
             e.hire_date::text as "hireDate", e.end_date::text as "endDate", u.id as "unitId"
        from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
        join org_unit u on u.company_id = e.company_id and u.id = a.org_unit_id
        left join lateral (
          select vv.name, vv.name_ar from org_unit_version vv
           where vv.company_id = u.company_id and vv.org_unit_id = u.id
           order by (vv.valid @> ${date}::date) desc, lower(vv.valid) desc
           limit 1
        ) v on true
       where e.company_id = ${companyId}::uuid and e.id = ${employmentId}::uuid`.execute(tx);
    const row = rows[0];
    if (!row) return undefined;
    const assignments = await sql<AssignmentFacts>`
      select job_title as "jobTitle", lower(valid)::text as "validFrom", upper(valid)::text as "validTo"
        from assignment where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid
       order by lower(valid)`.execute(tx);
    return { ...row, assignments: assignments.rows };
  }

  /** The employee's scope unit on `date` (undefined = unknown employment). */
  async scopeUnit(companyId: string, employmentId: string, date: string): Promise<string | undefined> {
    const { rows } = await sql<{ unitId: string }>`
      select a.org_unit_id as "unitId" from employment e join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
       where e.company_id = ${companyId}::uuid and e.id = ${employmentId}::uuid`.execute(currentTx());
    return rows[0]?.unitId;
  }

  // ── the register ────────────────────────────────────────────────────────────────────────────────────────────────

  async insertDocument(companyId: string, d: NewDocument, pdf: Buffer): Promise<string> {
    const tx = currentTx();
    const row = await tx
      .insertInto('issued_document')
      .values({
        company_id: companyId,
        document_type_id: d.documentTypeId,
        type_code: d.typeCode,
        year: d.year,
        seq: d.seq,
        number: d.number,
        language: d.language,
        employment_id: d.employmentId,
        leave_request_id: d.leaveRequestId,
        document_request_id: d.documentRequestId,
        org_unit_id: d.orgUnitId,
        signatory_id: d.signatoryId,
        snapshot: JSON.stringify(d.snapshot),
        template_version: d.templateVersion,
        renderer: d.renderer,
        content_sha256: d.sha256,
        size_bytes: d.sizeBytes,
        issue_date: d.issueDate,
        issued_by: d.issuedBy,
        client_request_id: d.clientRequestId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('issued_document_file').values({ document_id: row.id, company_id: companyId, pdf }).execute();
    return row.id;
  }

  async document(companyId: string, id: string): Promise<DocumentRow | undefined> {
    const { rows } = await sql<DocumentRow>`select ${DOCUMENT_COLUMNS} from issued_document d
      where d.company_id = ${companyId}::uuid and d.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async snapshot(companyId: string, id: string): Promise<DocumentSnapshot | undefined> {
    const row = await currentTx().selectFrom('issued_document').select('snapshot').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row?.snapshot as DocumentSnapshot | undefined;
  }

  async documentByClientRequest(companyId: string, clientRequestId: string): Promise<DocumentRow | undefined> {
    const { rows } = await sql<DocumentRow>`select ${DOCUMENT_COLUMNS} from issued_document d
      where d.company_id = ${companyId}::uuid and d.client_request_id = ${clientRequestId}::uuid`.execute(currentTx());
    return rows[0];
  }

  async documentsOf(companyId: string, employmentId: string, options: { issuedOnly?: boolean } = {}): Promise<DocumentRow[]> {
    const status = options.issuedOnly ? sql`and d.status = 'issued'` : sql``;
    const { rows } = await sql<DocumentRow>`select ${DOCUMENT_COLUMNS} from issued_document d
      where d.company_id = ${companyId}::uuid and d.employment_id = ${employmentId}::uuid ${status}
      order by d.issued_at desc, d.id desc`.execute(currentTx());
    return rows;
  }

  private registerFrom(companyId: string, f: RegisterFilter): RawBuilder<unknown> {
    const where: RawBuilder<unknown>[] = [sql`d.company_id = ${companyId}::uuid`, sql`a.org_unit_id in (${f.scope})`];
    if (f.typeCode) where.push(sql`d.type_code = ${f.typeCode}`);
    if (f.status) where.push(sql`d.status = ${f.status}`);
    if (f.employmentId) where.push(sql`d.employment_id = ${f.employmentId}::uuid`);
    if (f.leaveRequestId) where.push(sql`d.leave_request_id = ${f.leaveRequestId}::uuid`);
    if (f.unitId) {
      const depth = f.includeSubUnits ? sql`` : sql`and c.depth = 0`;
      where.push(sql`a.org_unit_id in (select c.descendant_id from org_unit_closure c
        where c.company_id = ${companyId}::uuid and c.ancestor_id = ${f.unitId}::uuid ${depth})`);
    }
    if (f.from) where.push(sql`d.issue_date >= ${f.from}::date`);
    if (f.to) where.push(sql`d.issue_date <= ${f.to}::date`);
    if (f.q) {
      const pattern = likeContains(f.q);
      where.push(sql`(upper(d.number) like upper(${pattern}) or p.search_text like search_normalize(${pattern})
        or e.matricule_search like search_normalize(${pattern}))`);
    }
    return sql`from issued_document d
      join employment e on e.company_id = d.company_id and e.id = d.employment_id
      join person p on p.company_id = e.company_id and p.id = e.person_id
      join lateral ${scopeAssignmentSql(sql`e.id`, f.today)} a on true
      where ${sql.join(where, sql` and `)}`;
  }

  /** The register in the caller's scope (the employee's scope unit today), newest first. */
  async register(companyId: string, f: RegisterFilter): Promise<{ rows: DocumentRow[]; total: number }> {
    const from = this.registerFrom(companyId, f);
    const count = await sql<{ n: number }>`select count(*)::int as n ${from}`.execute(currentTx());
    const { rows } = await sql<DocumentRow>`select ${DOCUMENT_COLUMNS} ${from}
      order by d.issued_at desc, d.id desc limit ${f.limit} offset ${f.offset}`.execute(currentTx());
    return { rows, total: count.rows[0]?.n ?? 0 };
  }

  async file(companyId: string, id: string): Promise<Buffer | undefined> {
    const row = await currentTx().selectFrom('issued_document_file').select('pdf').where('company_id', '=', companyId).where('document_id', '=', id).executeTakeFirst();
    return row?.pdf;
  }

  /** issued → void; false when it was not issued (already void). */
  async voidDocument(companyId: string, id: string, by: string, reason: string): Promise<boolean> {
    const result = await sql`update issued_document set status = 'void', voided_by = ${by}::uuid, voided_at = now(), void_reason = ${reason}
      where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'issued'`.execute(currentTx());
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  // ── self-service requests ───────────────────────────────────────────────────────────────────────────────────────

  async insertRequest(companyId: string, r: { employmentId: string; documentTypeId: string; language: DocumentLanguage; purpose: string | null; requestedBy: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('document_request')
      .values({
        company_id: companyId,
        employment_id: r.employmentId,
        document_type_id: r.documentTypeId,
        language: r.language,
        purpose: r.purpose,
        requested_by: r.requestedBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async request(companyId: string, id: string): Promise<RequestRow | undefined> {
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from document_request q
      join document_type t on t.company_id = q.company_id and t.id = q.document_type_id
      where q.company_id = ${companyId}::uuid and q.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async requests(companyId: string, ids: readonly string[]): Promise<RequestRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from document_request q
      join document_type t on t.company_id = q.company_id and t.id = q.document_type_id
      where q.company_id = ${companyId}::uuid and q.id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return rows;
  }

  async requestsOf(companyId: string, employmentId: string): Promise<RequestRow[]> {
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from document_request q
      join document_type t on t.company_id = q.company_id and t.id = q.document_type_id
      where q.company_id = ${companyId}::uuid and q.employment_id = ${employmentId}::uuid
      order by q.requested_at desc, q.id desc`.execute(currentTx());
    return rows;
  }

  async pendingRequestExists(companyId: string, employmentId: string, typeId: string): Promise<boolean> {
    const row = await currentTx()
      .selectFrom('document_request')
      .select('id')
      .where('company_id', '=', companyId)
      .where('employment_id', '=', employmentId)
      .where('document_type_id', '=', typeId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return row !== undefined;
  }

  async setRequestInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await currentTx().updateTable('document_request').set({ workflow_instance_id: instanceId }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async setRequestStatus(companyId: string, id: string, status: 'approved' | 'rejected' | 'cancelled', issuedDocumentId: string | null = null): Promise<void> {
    await currentTx()
      .updateTable('document_request')
      .set({ status, ...(issuedDocumentId ? { issued_document_id: issuedDocumentId } : {}) })
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .execute();
  }

  async definitionId(companyId: string, code: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row?.id;
  }

  /** Display names of the company's members. */
  async names(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }
}
