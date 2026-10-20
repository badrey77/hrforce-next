import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { TemplateField, TemplateLayouts } from '../domain/template-layout.js';

export type TemplateStatus = 'draft' | 'published' | 'archived';

export interface TemplateVersionRow {
  id: string;
  typeId: string;
  version: number;
  status: TemplateStatus;
  layouts: TemplateLayouts;
  fields: TemplateField[];
  basedOn: string | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  note: string | null;
  /** documents issued with this version */
  issuedCount: number;
}

const TS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const VERSION_COLUMNS = sql`v.id, v.document_type_id as "typeId", v.version, v.status, v.layouts, v.fields, v.based_on as "basedOn", v.revision,
  v.created_by as "createdBy", ${TS('v.created_at')} as "createdAt", v.updated_by as "updatedBy", ${TS('v.updated_at')} as "updatedAt",
  v.published_by as "publishedBy", ${TS('v.published_at')} as "publishedAt", v.note,
  (select count(*)::int from issued_document d where d.company_id = v.company_id and d.template_version_id = v.id) as "issuedCount"`;

/**
 * Designed template versions (docs/contracts/document-templates.md › Data) — through the request transaction, always
 * filtered by company; RLS is the backstop. The database guards the transitions (draft → published → archived, only a
 * draft deleted) and the "one draft / one published per type" rule; the service maps those errors to problems.
 */
@Injectable()
export class TemplatesRepository {
  async versions(companyId: string, typeId: string): Promise<TemplateVersionRow[]> {
    const { rows } = await sql<TemplateVersionRow>`select ${VERSION_COLUMNS} from document_template_version v
      where v.company_id = ${companyId}::uuid and v.document_type_id = ${typeId}::uuid order by v.version desc`.execute(currentTx());
    return rows;
  }

  async version(companyId: string, id: string): Promise<TemplateVersionRow | undefined> {
    const { rows } = await sql<TemplateVersionRow>`select ${VERSION_COLUMNS} from document_template_version v
      where v.company_id = ${companyId}::uuid and v.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  /** Locks a version row for a write (save, publish, discard): concurrent writers queue here. */
  async lockVersion(companyId: string, id: string): Promise<void> {
    await sql`select 1 from document_template_version where company_id = ${companyId}::uuid and id = ${id}::uuid for update`.execute(currentTx());
  }

  /** Serialises the version writes of one type (draft creation, publish, revert: numbers and the one-draft rule). */
  async lockType(companyId: string, typeId: string): Promise<void> {
    await sql`select 1 from document_type where company_id = ${companyId}::uuid and id = ${typeId}::uuid for update`.execute(currentTx());
  }

  async insertDraft(
    companyId: string,
    d: { typeId: string; layouts: TemplateLayouts; fields: TemplateField[]; basedOn: string | null; note: string | null; userId: string },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into document_template_version (company_id, document_type_id, version, layouts, fields, based_on, note, created_by, updated_by)
      values (${companyId}::uuid, ${d.typeId}::uuid,
              (select coalesce(max(version), 0) + 1 from document_template_version where company_id = ${companyId}::uuid and document_type_id = ${d.typeId}::uuid),
              ${JSON.stringify(d.layouts)}::jsonb, ${JSON.stringify(d.fields)}::jsonb, ${d.basedOn}, ${d.note}, ${d.userId}::uuid, ${d.userId}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('document_template_version: no id returned');
    return id;
  }

  /** Saves a draft when its revision is still `revision`; false when it changed meanwhile (or is no longer a draft). */
  async saveDraft(companyId: string, id: string, d: { revision: number; layouts: TemplateLayouts; fields: TemplateField[]; note: string | null; userId: string }): Promise<boolean> {
    const result = await sql`
      update document_template_version
         set layouts = ${JSON.stringify(d.layouts)}::jsonb, fields = ${JSON.stringify(d.fields)}::jsonb, note = ${d.note},
             revision = revision + 1, updated_by = ${d.userId}::uuid, updated_at = now()
       where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'draft' and revision = ${d.revision}`.execute(currentTx());
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  async deleteDraft(companyId: string, id: string): Promise<boolean> {
    const result = await sql`delete from document_template_version where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'draft'`.execute(currentTx());
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  /** The type's published version → archived (none: nothing). */
  async archivePublished(companyId: string, typeId: string): Promise<{ id: string; version: number } | undefined> {
    const { rows } = await sql<{ id: string; version: number }>`
      update document_template_version set status = 'archived'
       where company_id = ${companyId}::uuid and document_type_id = ${typeId}::uuid and status = 'published'
      returning id, version`.execute(currentTx());
    return rows[0];
  }

  async publish(companyId: string, id: string, userId: string, note: string | null): Promise<void> {
    await sql`update document_template_version set status = 'published', published_by = ${userId}::uuid, published_at = now(),
        note = coalesce(${note}, note)
      where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'draft'`.execute(currentTx());
  }

  async setTypeTemplate(companyId: string, typeId: string, publishedId: string | null): Promise<void> {
    await currentTx()
      .updateTable('document_type')
      .set({ template_mode: publishedId ? 'designed' : 'builtin', published_template_id: publishedId })
      .where('company_id', '=', companyId)
      .where('id', '=', typeId)
      .execute();
  }

  /** The published versions of these types (issue form fields, DocumentTypeView.template). */
  async published(companyId: string, ids: readonly string[]): Promise<Map<string, TemplateVersionRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await sql<TemplateVersionRow>`select ${VERSION_COLUMNS} from document_template_version v
      where v.company_id = ${companyId}::uuid and v.id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Version numbers of these version ids (the register's `template`). */
  async numbers(companyId: string, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { rows } = await sql<{ id: string; version: number }>`select id, version from document_template_version
      where company_id = ${companyId}::uuid and id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return new Map(rows.map((r) => [r.id, r.version]));
  }
}
