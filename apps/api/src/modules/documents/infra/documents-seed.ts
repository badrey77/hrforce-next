/*
 * Document defaults of a company and the demo documents of `seed:dev` / the e2e fixtures
 * (docs/contracts/documents.md › Seed). Runs as the MIGRATOR (owner, BYPASSRLS): company_id written explicitly.
 * Idempotent: fixed ids and `on conflict do nothing`; demo documents are issued only when the company has none.
 * TEST DATA: the profile, identifiers and names below are fictitious.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { runWithContext } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import type { PdfRenderer } from '../../../platform/pdf/pdf-renderer.js';
import { demoEmployees } from '../../employment/index.js';
import { DEMO_USERS } from '../../identity/index.js';
import { LEAVE_DEMO, LeaveFacts } from '../../leave/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { seedWorkflowDefinitions, type SeedDefinition } from '../../workflow/index.js';
import { DocumentIssuer } from '../application/document-issuer.js';
import { DEFAULT_DOCUMENT_TYPES, DOCUMENT_WORKFLOW_CODE, type DocumentLanguage, type DocumentTypeCode } from '../domain/types.js';
import { DocumentsRepository } from './documents.repository.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** The self-service workflow: one HR step (`document.issue` over the employee's unit). */
export const DOCUMENT_DEFINITION: SeedDefinition = {
  code: DOCUMENT_WORKFLOW_CODE,
  names: { fr: 'RH uniquement', ar: 'الموارد البشرية فقط', en: 'HR only' },
  steps: [{ key: 'hr', kind: 'permission', permission: 'document.issue', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } }],
};

/** The three document types and the `document.hr_only` workflow of a company (new companies; 0014 did existing ones). */
export async function seedDocumentDefaults(db: Executor, companyId: string): Promise<Map<string, string>> {
  await seedWorkflowDefinitions(db, companyId, [DOCUMENT_DEFINITION]);
  for (const t of DEFAULT_DOCUMENT_TYPES) {
    await sql`
      insert into document_type (company_id, code, name_fr, name_ar, name_en, number_format, languages, self_service, sort_order)
      values (${companyId}::uuid, ${t.code}, ${t.names.fr}, ${t.names.ar}, ${t.names.en}, ${t.numberFormat}, '{fr,ar}', ${t.selfService}, ${t.sortOrder})
      on conflict (company_id, code) do nothing`.execute(db);
  }
  const rows = await db.selectFrom('document_type').select(['id', 'code']).where('company_id', '=', companyId).execute();
  return new Map(rows.map((r) => [r.code, r.id]));
}

// ── a small generated PNG (the demo logo) ───────────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** 160 × 48 RGB: a teal band with a lighter stripe — deterministic bytes. */
export function demoLogoPng(): Buffer {
  const width = 160;
  const height = 48;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const stripe = x > 20 && x < 44 && y > 10 && y < 38;
      const [r, g, b] = stripe ? [240, 248, 246] : [15, 118, 110];
      row.writeUInt8(r, 1 + x * 3);
      row.writeUInt8(g, 2 + x * 3);
      row.writeUInt8(b, 3 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ── demo settings ───────────────────────────────────────────────────────────────────────────────────────────────────

const fixed = (n: number) => `0190a5d0-0000-7000-8020-${n.toString(16).padStart(12, '0')}`;

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`demo documents: unknown unit ${code}`);
  return unit.id;
}

export const DEMO_SIGNATORIES = {
  hrDirector: fixed(1),
  estDirector: fixed(2),
} as const;

export interface SeedProfile {
  legalNameFr: string;
  legalNameAr: string | null;
  addressFr: string;
  addressAr: string | null;
  cityFr: string;
  cityAr: string | null;
  nif?: string | null;
  nis?: string | null;
  rc?: string | null;
  footerFr?: string | null;
  footerAr?: string | null;
  logo?: Buffer | null;
}

/** Upserts a company's letterhead (seeds and fixtures). */
export async function seedCompanyProfile(db: Executor, companyId: string, p: SeedProfile): Promise<void> {
  const logo = p.logo ?? null;
  await sql`
    insert into company_profile (company_id, legal_name_fr, legal_name_ar, address_fr, address_ar, city_fr, city_ar, phone, email, nif, nis, rc,
                                 footer_fr, footer_ar, logo, logo_mime, logo_sha256)
    values (${companyId}::uuid, ${p.legalNameFr}, ${p.legalNameAr}, ${p.addressFr}, ${p.addressAr}, ${p.cityFr}, ${p.cityAr}, '+213 21 00 00 00',
            'rh@demo.dz', ${p.nif ?? null}, ${p.nis ?? null}, ${p.rc ?? null}, ${p.footerFr ?? null}, ${p.footerAr ?? null}, ${logo},
            ${logo ? 'image/png' : null}, ${logo ? createHash('sha256').update(logo).digest() : null})
    on conflict (company_id) do nothing`.execute(db);
}

export async function seedSignatory(
  db: Executor,
  companyId: string,
  s: { id: string; orgUnitId: string | null; nameFr: string; nameAr: string; titleFr: string; titleAr: string },
): Promise<void> {
  await sql`
    insert into document_signatory (id, company_id, org_unit_id, name_fr, name_ar, title_fr, title_ar)
    values (${s.id}::uuid, ${companyId}::uuid, ${s.orgUnitId}::uuid, ${s.nameFr}, ${s.nameAr}, ${s.titleFr}, ${s.titleAr})
    on conflict do nothing`.execute(db);
}

/**
 * DEMO letterhead (fictitious: "Entreprise Démo HRForce", test identifiers, a generated logo) and signatories: the HR
 * director company-wide and the Région Est director (Souad Cherif) on REG-EST. No rendering: fixtures use it too.
 */
export async function seedDemoDocumentSettings(db: Executor): Promise<void> {
  const companyId = DEMO_ORGANIZATION.company.id;
  await seedDocumentDefaults(db, companyId);
  await seedCompanyProfile(db, companyId, {
    legalNameFr: 'Entreprise Démo HRForce',
    legalNameAr: 'مؤسسة هرفورس التجريبية',
    addressFr: '12 rue Didouche Mourad, 16000 Alger',
    addressAr: '12 شارع ديدوش مراد، 16000 الجزائر',
    cityFr: 'Alger',
    cityAr: 'الجزائر',
    nif: '000016999999999 TEST',
    nis: '000016999999999 TEST',
    rc: '16/00-9999999 B 26 TEST',
    footerFr: 'Données de test — document fictif sans valeur juridique',
    footerAr: 'بيانات تجريبية — وثيقة وهمية بدون قيمة قانونية',
    logo: demoLogoPng(),
  });
  await seedSignatory(db, companyId, {
    id: DEMO_SIGNATORIES.hrDirector,
    orgUnitId: null,
    nameFr: 'Farid Belkacem',
    nameAr: 'فريد بلقاسم',
    titleFr: 'Directeur des ressources humaines',
    titleAr: 'مدير الموارد البشرية',
  });
  await seedSignatory(db, companyId, {
    id: DEMO_SIGNATORIES.estDirector,
    orgUnitId: unitId('REG-EST'),
    nameFr: 'Souad Cherif',
    nameAr: 'سعاد شريف',
    titleFr: 'Directrice de la Région Est',
    titleAr: 'مديرة منطقة الشرق',
  });
}

// ── demo documents (rendered) ───────────────────────────────────────────────────────────────────────────────────────

class NoAuditEvents extends AuditEvents {
  record(): Promise<void> {
    return Promise.resolve();
  }
  recordFor(): Promise<void> {
    return Promise.resolve();
  }
}

function employment(n: number): string {
  const e = demoEmployees()[n - 1];
  if (!e) throw new Error(`demo documents: unknown employee ${n}`);
  return e.employmentId;
}

/**
 * Issues the demo documents through the real issuing core (numbers, snapshots, PDFs): attestations for EMP-0027 (fr)
 * and EMP-0031 (ar) of Région Est and EMP-0036 (fr) of Région Ouest, a certificat for EMP-0025 (ended 2026-06-30), a
 * titre de congé for agent.annaba's approved leave (when the leave demo requests exist), one void attestation
 * (EMP-0028), and a pending self-service attestation request of agent.annaba. Skipped when documents exist.
 */
export async function seedDemoDocuments(db: Transaction<DB>, renderer: PdfRenderer, today: string): Promise<{ documents: number; requests: number }> {
  const companyId = DEMO_ORGANIZATION.company.id;
  await seedDemoDocumentSettings(db);
  const existing = await db.selectFrom('issued_document').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst();
  if (existing) return { documents: 0, requests: 0 };
  const admin = DEMO_USERS.find((u) => u.email === 'rh.admin@demo.dz')?.id ?? '';
  const repo = new DocumentsRepository();
  const issuer = new DocumentIssuer(repo, renderer, new NoAuditEvents(), new LeaveFacts());
  const approvedLeave = '0190a5d0-0000-7000-8010-000000000001'; // leave demo request n°1 (approved, agent.annaba)
  const hasLeave = (await db.selectFrom('leave_request').select('id').where('company_id', '=', companyId).where('id', '=', approvedLeave).executeTakeFirst()) !== undefined;
  const plan: { type: DocumentTypeCode; employee: number; lang: DocumentLanguage; leave?: string; void?: string }[] = [
    { type: 'attestation_travail', employee: 27, lang: 'fr' },
    { type: 'attestation_travail', employee: 31, lang: 'ar' },
    { type: 'attestation_travail', employee: 36, lang: 'fr' },
    { type: 'certificat_travail', employee: 25, lang: 'fr' },
    { type: 'attestation_travail', employee: 28, lang: 'ar', void: 'Erreur de langue : réémise en français' },
    ...(hasLeave ? [{ type: 'titre_conge' as const, employee: 30, lang: 'fr' as const, leave: approvedLeave }] : []),
  ];
  let documents = 0;
  await runWithContext({ requestId: 'seed-dev', userId: admin, companyId, tx: db }, async () => {
    for (const item of plan) {
      const prepared = await issuer.prepare(companyId, {
        typeCode: item.type,
        employmentId: employment(item.employee),
        leaveRequestId: item.leave ?? null,
        language: item.lang,
        issueDate: today,
      });
      const id = await issuer.issue(companyId, prepared, { issuedBy: admin, via: 'hr', documentRequestId: null, clientRequestId: null });
      if (item.void) await repo.voidDocument(companyId, id, admin, item.void);
      documents += 1;
    }
  });
  // agent.annaba asks for an attestation in Arabic: pending at the HR step (document.issue over Agence Annaba)
  const types = await seedDocumentDefaults(db, companyId);
  const definition = await db.selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', DOCUMENT_WORKFLOW_CODE).executeTakeFirstOrThrow();
  const requestId = fixed(101);
  const instanceId = fixed(102);
  const inserted = await sql`
    insert into document_request (id, company_id, employment_id, document_type_id, language, purpose, requested_by, requested_at)
    values (${requestId}::uuid, ${companyId}::uuid, ${LEAVE_DEMO.agent.employmentId}::uuid, ${types.get('attestation_travail') ?? ''}::uuid, 'ar',
            'Dossier de prêt bancaire', ${LEAVE_DEMO.agent.userId}::uuid, '2026-09-25T09:00:00Z')
    on conflict do nothing`.execute(db);
  if (Number(inserted.numAffectedRows ?? 0) === 0) return { documents, requests: 0 };
  await sql`
    insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, subject_user_id, started_at)
    values (${instanceId}::uuid, ${companyId}::uuid, ${definition.id}::uuid, 'document_request', ${requestId}::uuid, 'pending', 0,
            ${LEAVE_DEMO.agent.userId}::uuid, ${LEAVE_DEMO.agent.userId}::uuid, '2026-09-25T09:00:00Z')`.execute(db);
  await sql`
    insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, permission, scope_unit_id, created_at)
    values (${fixed(103)}::uuid, ${companyId}::uuid, ${instanceId}::uuid, 'hr', 0, 'permission', 'document.issue', ${unitId('AG-ANNABA')}::uuid,
            '2026-09-25T09:00:00Z')`.execute(db);
  await sql`update document_request set workflow_instance_id = ${instanceId}::uuid where id = ${requestId}::uuid`.execute(db);
  return { documents, requests: 1 };
}
