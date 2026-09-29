import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { scopeAssignmentSql } from '../../staffing/index.js';
import type { AccessClass, EmployeeFileMime } from '../domain/employee-files.js';

export interface CategoryRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  accessClass: AccessClass;
  retentionYearsAfterEnd: number | null;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

export interface FileRow {
  id: string;
  employmentId: string;
  categoryId: string;
  categoryCode: string;
  accessClass: AccessClass;
  title: string;
  originalFilename: string;
  mime: EmployeeFileMime;
  sizeBytes: number;
  sha256: string;
  documentDate: string | null;
  expiresOn: string | null;
  uploadedBy: string;
  uploadedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  purgedAt: string | null;
}

export interface NewFile {
  employmentId: string;
  categoryId: string;
  title: string;
  originalFilename: string;
  mime: EmployeeFileMime;
  sha256: Buffer;
  documentDate: string | null;
  expiresOn: string | null;
  uploadedBy: string;
  content: Buffer;
}

/** An employment and the person's other employments (the file set a request may see). */
export interface EmploymentRef {
  employmentId: string;
  personId: string;
  hireDate: string;
  /** the scope unit on the date asked (assignment valid then, else the last one) */
  unitId: string;
}

/** A file whose bytes the retention job may remove (the domain decides with isPurgeDue). */
export interface PurgeCandidate {
  id: string;
  retentionYears: number;
  endDates: (string | null)[];
}

const TS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const CATEGORY_COLUMNS = sql`c.id, c.code, c.name_fr as "nameFr", c.name_ar as "nameAr", c.name_en as "nameEn", c.access_class as "accessClass",
  c.retention_years_after_end as "retentionYearsAfterEnd", c.active, c.sort_order as "sortOrder", c.is_system as "isSystem"`;

const FILE_COLUMNS = sql`f.id, f.employment_id as "employmentId", f.category_id as "categoryId", c.code as "categoryCode",
  c.access_class as "accessClass", f.title, f.original_filename as "originalFilename", f.mime, f.size_bytes as "sizeBytes",
  encode(f.sha256, 'hex') as sha256, f.document_date::text as "documentDate", f.expires_on::text as "expiresOn",
  f.uploaded_by as "uploadedBy", ${TS('f.uploaded_at')} as "uploadedAt", ${TS('f.deleted_at')} as "deletedAt",
  f.deleted_by as "deletedBy", f.delete_reason as "deleteReason", ${TS('f.purged_at')} as "purgedAt"`;

/**
 * Employee file data (docs/contracts/documents.md › Phase B) — through the request transaction (`currentTx()`), always
 * filtered by company; RLS is the backstop. Listing never reads the bytes (employee_file_content).
 */
@Injectable()
export class EmployeeFilesRepository {
  // ── categories ──────────────────────────────────────────────────────────────────────────────────────────────────

  async categories(companyId: string): Promise<CategoryRow[]> {
    const { rows } = await sql<CategoryRow>`select ${CATEGORY_COLUMNS} from employee_file_category c
      where c.company_id = ${companyId}::uuid order by c.sort_order, c.code`.execute(currentTx());
    return rows;
  }

  async insertCategory(companyId: string, c: { code: string; nameFr: string; nameAr: string; nameEn: string; retentionYearsAfterEnd: number | null; sortOrder: number }): Promise<string> {
    const row = await currentTx()
      .insertInto('employee_file_category')
      .values({
        company_id: companyId,
        code: c.code,
        name_fr: c.nameFr,
        name_ar: c.nameAr,
        name_en: c.nameEn,
        access_class: 'standard',
        retention_years_after_end: c.retentionYearsAfterEnd,
        sort_order: c.sortOrder,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updateCategory(companyId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await currentTx().updateTable('employee_file_category').set(patch).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  // ── employments ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** The employment (with its scope unit on `date`); undefined = unknown in this company. */
  async employment(companyId: string, employmentId: string, date: string): Promise<EmploymentRef | undefined> {
    const { rows } = await sql<EmploymentRef>`
      select e.id as "employmentId", e.person_id as "personId", e.hire_date::text as "hireDate", a.org_unit_id as "unitId"
        from employment e join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
       where e.company_id = ${companyId}::uuid and e.id = ${employmentId}::uuid`.execute(currentTx());
    return rows[0];
  }

  /**
   * The employments whose files a request on `employment` shows: itself and the person's EARLIER employments (a rehired
   * person keeps their diplomas; an old employment does not show a later one's files).
   */
  async fileSet(companyId: string, employment: EmploymentRef): Promise<string[]> {
    const rows = await currentTx()
      .selectFrom('employment')
      .select('id')
      .where('company_id', '=', companyId)
      .where('person_id', '=', employment.personId)
      .where((eb) => eb.or([eb('id', '=', employment.employmentId), eb('hire_date', '<', sql<Date>`${employment.hireDate}::date`)]))
      .execute();
    return rows.map((r) => r.id);
  }

  // ── files ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async files(companyId: string, employmentIds: readonly string[], f: { categoryId?: string | undefined; includeDeleted: boolean; includeMedical: boolean }): Promise<FileRow[]> {
    if (employmentIds.length === 0) return [];
    const where = [sql`f.company_id = ${companyId}::uuid`, sql`f.employment_id in (${sql.join(employmentIds.map((id) => sql`${id}::uuid`))})`];
    if (f.categoryId) where.push(sql`f.category_id = ${f.categoryId}::uuid`);
    if (!f.includeDeleted) where.push(sql`f.deleted_at is null and f.purged_at is null`);
    if (!f.includeMedical) where.push(sql`c.access_class <> 'medical'`);
    const { rows } = await sql<FileRow>`select ${FILE_COLUMNS} from employee_file f
      join employee_file_category c on c.company_id = f.company_id and c.id = f.category_id
      where ${sql.join(where, sql` and `)}
      order by f.uploaded_at desc, f.id desc`.execute(currentTx());
    return rows;
  }

  async file(companyId: string, id: string): Promise<FileRow | undefined> {
    const { rows } = await sql<FileRow>`select ${FILE_COLUMNS} from employee_file f
      join employee_file_category c on c.company_id = f.company_id and c.id = f.category_id
      where f.company_id = ${companyId}::uuid and f.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  /** The metadata row then the bytes, in the request transaction. A live duplicate raises employee_file_live_sha_uk. */
  async insertFile(companyId: string, f: NewFile): Promise<string> {
    const tx = currentTx();
    const row = await tx
      .insertInto('employee_file')
      .values({
        company_id: companyId,
        employment_id: f.employmentId,
        category_id: f.categoryId,
        title: f.title,
        original_filename: f.originalFilename,
        mime: f.mime,
        size_bytes: f.content.length,
        sha256: f.sha256,
        document_date: f.documentDate,
        expires_on: f.expiresOn,
        uploaded_by: f.uploadedBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('employee_file_content').values({ file_id: row.id, company_id: companyId, content: f.content }).execute();
    return row.id;
  }

  /** Whether a live file of these employments already has these bytes (duplicate detection before inserting). */
  async liveDuplicate(companyId: string, employmentId: string, sha256: Buffer): Promise<boolean> {
    const row = await currentTx()
      .selectFrom('employee_file')
      .select('id')
      .where('company_id', '=', companyId)
      .where('employment_id', '=', employmentId)
      .where('sha256', '=', sha256)
      .where('deleted_at', 'is', null)
      .where('purged_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async content(companyId: string, id: string): Promise<Buffer | undefined> {
    const row = await currentTx().selectFrom('employee_file_content').select('content').where('company_id', '=', companyId).where('file_id', '=', id).executeTakeFirst();
    return row?.content;
  }

  /** Tombstone then bytes (the content guard needs the tombstone first); false when already deleted or purged. */
  async deleteFile(companyId: string, id: string, by: string, reason: string): Promise<boolean> {
    const tx = currentTx();
    const result = await sql`update employee_file set deleted_at = now(), deleted_by = ${by}::uuid, delete_reason = ${reason}
      where company_id = ${companyId}::uuid and id = ${id}::uuid and deleted_at is null and purged_at is null`.execute(tx);
    if (Number(result.numAffectedRows ?? 0) !== 1) return false;
    await tx.deleteFrom('employee_file_content').where('company_id', '=', companyId).where('file_id', '=', id).execute();
    return true;
  }

  /** Display names of the company's members. */
  async names(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }
}

// ── retention (the worker, as hrforce_worker, inside inCompany) ──────────────────────────────────────────────────────

/**
 * Live files of the company whose category has a retention, with the end dates of every employment of their person
 * (null = still employed).
 */
export async function purgeCandidates(tx: Transaction<DB>, companyId: string): Promise<PurgeCandidate[]> {
  const { rows } = await sql<PurgeCandidate>`
    select f.id, c.retention_years_after_end as "retentionYears",
           (select array_agg(o.end_date::text) from employment o
             where o.company_id = e.company_id and o.person_id = e.person_id) as "endDates"
      from employee_file f
      join employee_file_category c on c.company_id = f.company_id and c.id = f.category_id
      join employment e on e.company_id = f.company_id and e.id = f.employment_id
     where f.company_id = ${companyId}::uuid and c.retention_years_after_end is not null
       and f.deleted_at is null and f.purged_at is null
     order by f.id`.execute(tx);
  return rows;
}

/** Marks the files purged, then removes their bytes (metadata kept). Returns how many were purged. */
export async function purgeFiles(tx: Transaction<DB>, companyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const marked = await tx
    .updateTable('employee_file')
    .set({ purged_at: sql<Date>`now()` })
    .where('company_id', '=', companyId)
    .where('id', 'in', ids)
    .where('purged_at', 'is', null)
    .where('deleted_at', 'is', null)
    .returning('id')
    .execute();
  const markedIds = marked.map((r) => r.id);
  if (markedIds.length > 0) {
    await tx.deleteFrom('employee_file_content').where('company_id', '=', companyId).where('file_id', 'in', markedIds).execute();
  }
  return markedIds.length;
}
