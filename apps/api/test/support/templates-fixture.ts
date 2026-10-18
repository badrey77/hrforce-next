import { randomUUID } from 'node:crypto';
import type { TemplateLayout } from '../../src/modules/documents/domain/template-layout.js';
import { query } from './test-database.js';

/** A small valid French layout (a title, a sentence with placeholders, the signature). */
export const SIMPLE_LAYOUT: TemplateLayout = {
  v: 1,
  page: { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' },
  blocks: [
    { id: 't', type: 'title', align: 'center', content: [{ t: 'text', text: 'DOCUMENT DE TEST' }] },
    {
      id: 'p',
      type: 'paragraph',
      align: 'justify',
      content: [
        { t: 'var', key: 'employee.civility' },
        { t: 'text', text: ' ' },
        { t: 'var', key: 'employee.fullName', bold: true },
        { t: 'text', text: ', matricule ' },
        { t: 'var', key: 'employee.matricule' },
        { t: 'text', text: '.' },
      ],
    },
    { id: 's', type: 'signature', align: 'end' },
  ],
};

export interface TemplateFixture {
  /** custom type with one draft (to publish) */
  publishType: string;
  toPublish: string;
  /** custom type with an archived version 1 (to read and preview) and a draft version 2 (to save) */
  editType: string;
  archived: string;
  toSave: string;
  /** custom type with one draft (to discard) */
  discardType: string;
  toDiscard: string;
  /** the company's titre de congé (system, built-in, no draft): a draft can be created on it */
  titreType: string;
  /** the company's certificat de travail: designed (version 1 published) when `designedCertificat`, to revert */
  certificatType: string;
}

/**
 * Template versions of one company, written as the superuser (BYPASSRLS): three custom types (French only, inactive)
 * with the versions the route tests need. `tag` keeps codes and number formats unique per company.
 */
export async function seedTemplateFixture(superuserUrl: string, companyId: string, userId: string, tag: string, options: { designedCertificat?: boolean } = {}): Promise<TemplateFixture> {
  const layouts = JSON.stringify({ fr: SIMPLE_LAYOUT });
  const type = async (code: string, format: string): Promise<string> => {
    const id = randomUUID();
    await query(
      superuserUrl,
      `insert into document_type (id, company_id, code, kind, template_mode, name_fr, name_ar, name_en, subject, employment_rule, number_format, languages, self_service, active, sort_order)
       values ($1, $2, $3, 'custom', 'designed', $4, 'وثيقة', $4, 'employment', 'any', $5, '{fr}', false, false, 90)`,
      [id, companyId, code, `Type ${code}`, format],
    );
    return id;
  };
  const version = async (typeId: string, number: number, status: 'draft' | 'published' | 'archived'): Promise<string> => {
    const id = randomUUID();
    await query(
      superuserUrl,
      `insert into document_template_version (id, company_id, document_type_id, version, status, layouts, fields, based_on, created_by, updated_by, published_by, published_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, 'blank', $7, $7, $8, $9)`,
      [id, companyId, typeId, number, status, layouts, userId, status === 'draft' ? null : userId, status === 'draft' ? null : new Date().toISOString()],
    );
    return id;
  };
  const system = async (code: string) => (await query<{ id: string }>(superuserUrl, 'select id from document_type where company_id = $1 and code = $2', [companyId, code]))[0]?.id ?? '';

  const publishType = await type(`fx_publish_${tag}`, `FXP${tag.toUpperCase()}-{YYYY}-{SEQ}`);
  const editType = await type(`fx_edit_${tag}`, `FXE${tag.toUpperCase()}-{YYYY}-{SEQ}`);
  const discardType = await type(`fx_discard_${tag}`, `FXD${tag.toUpperCase()}-{YYYY}-{SEQ}`);
  const fixture: TemplateFixture = {
    publishType,
    toPublish: await version(publishType, 1, 'draft'),
    editType,
    archived: await version(editType, 1, 'archived'),
    toSave: await version(editType, 2, 'draft'),
    discardType,
    toDiscard: await version(discardType, 1, 'draft'),
    titreType: await system('titre_conge'),
    certificatType: await system('certificat_travail'),
  };
  if (options.designedCertificat) {
    const published = await version(fixture.certificatType, 1, 'published');
    await query(superuserUrl, `update document_type set template_mode = 'designed', published_template_id = $2 where id = $1`, [fixture.certificatType, published]);
  }
  return fixture;
}
