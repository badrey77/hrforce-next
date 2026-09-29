/*
 * Demo employee files of `seed:dev` and the e2e fixtures (docs/contracts/documents.md › Phase B). Runs as the MIGRATOR
 * (owner, BYPASSRLS): company_id written explicitly. Idempotent: fixed ids and `on conflict do nothing`.
 * TEST DATA: the files are generated placeholders (a one-page PDF with a line of text, the demo logo PNG).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { demoEmployees } from '../../employment/index.js';
import { DEMO_USERS } from '../../identity/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import type { EmployeeFileMime } from '../domain/employee-files.js';
import { demoLogoPng } from './documents-seed.js';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * A minimal, valid one-page PDF 1.4 showing `text` (Helvetica, ASCII only) — deterministic bytes with a correct
 * cross-reference table, so viewers open it without repairing it.
 */
export function demoPdf(text: string): Buffer {
  const safe = text.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 18 Tf 72 760 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const fixed = (n: number) => `0190a5d0-0000-7000-8021-${n.toString(16).padStart(12, '0')}`;

/** Fixed ids of the demo files (EMP-0027 of Agence Constantine, EMP-0036 of Agence Oran). */
export const DEMO_EMPLOYEE_FILES = {
  diplomaEst: fixed(1),
  idCardEst: fixed(2),
  medicalEst: fixed(3),
  contractOuest: fixed(4),
} as const;

function employmentOf(n: number): string {
  const e = demoEmployees()[n - 1];
  if (!e) throw new Error(`demo employee files: unknown employee ${n}`);
  return e.employmentId;
}

export interface SeedEmployeeFile {
  id: string;
  employmentId: string;
  categoryCode: string;
  title: string;
  originalFilename: string;
  mime: EmployeeFileMime;
  content: Buffer;
  documentDate?: string | null;
  expiresOn?: string | null;
  uploadedBy: string;
}

/** Inserts files (metadata + bytes) for a company; the category is looked up by code. */
export async function seedEmployeeFiles(db: Executor, companyId: string, files: readonly SeedEmployeeFile[]): Promise<number> {
  let inserted = 0;
  for (const f of files) {
    const result = await sql`
      insert into employee_file (id, company_id, employment_id, category_id, title, original_filename, mime, size_bytes, sha256,
                                 document_date, expires_on, uploaded_by, uploaded_at)
      select ${f.id}::uuid, ${companyId}::uuid, ${f.employmentId}::uuid, c.id, ${f.title}, ${f.originalFilename}, ${f.mime},
             ${f.content.length}, ${createHash('sha256').update(f.content).digest()}, ${f.documentDate ?? null}::date,
             ${f.expiresOn ?? null}::date, ${f.uploadedBy}::uuid, '2026-09-20T08:00:00Z'
        from employee_file_category c where c.company_id = ${companyId}::uuid and c.code = ${f.categoryCode}
      on conflict do nothing`.execute(db);
    if (Number(result.numAffectedRows ?? 0) === 0) continue;
    await sql`insert into employee_file_content (file_id, company_id, content) values (${f.id}::uuid, ${companyId}::uuid, ${f.content})`.execute(db);
    inserted += 1;
  }
  return inserted;
}

/**
 * DEMO: EMP-0027 (Est) has a diploma (PDF), an identity card (PNG, expiring) and a MEDICAL fitness certificate that no
 * seeded role can see (docs/contracts/documents.md › Assumptions 14); EMP-0036 (Ouest) has a contract (PDF).
 */
export async function seedDemoEmployeeFiles(db: Executor): Promise<number> {
  const companyId = DEMO_ORGANIZATION.company.id;
  const admin = DEMO_USERS.find((u) => u.email === 'rh.admin@demo.dz')?.id ?? '';
  return seedEmployeeFiles(db, companyId, [
    {
      id: DEMO_EMPLOYEE_FILES.diplomaEst,
      employmentId: employmentOf(27),
      categoryCode: 'diploma',
      title: 'Licence en sciences de gestion',
      originalFilename: 'licence-gestion.pdf',
      mime: 'application/pdf',
      content: demoPdf('TEST DATA - Licence en sciences de gestion'),
      documentDate: '2012-07-01',
      uploadedBy: admin,
    },
    {
      id: DEMO_EMPLOYEE_FILES.idCardEst,
      employmentId: employmentOf(27),
      categoryCode: 'id_document',
      title: "Carte nationale d'identité",
      originalFilename: 'cni.png',
      mime: 'image/png',
      content: demoLogoPng(),
      expiresOn: '2031-03-31',
      uploadedBy: admin,
    },
    {
      id: DEMO_EMPLOYEE_FILES.medicalEst,
      employmentId: employmentOf(27),
      categoryCode: 'medical',
      title: "Certificat d'aptitude",
      originalFilename: 'aptitude.pdf',
      mime: 'application/pdf',
      content: demoPdf('TEST DATA - Certificat d aptitude'),
      documentDate: '2026-01-15',
      uploadedBy: admin,
    },
    {
      id: DEMO_EMPLOYEE_FILES.contractOuest,
      employmentId: employmentOf(36),
      categoryCode: 'contract',
      title: 'Contrat de travail',
      originalFilename: 'contrat.pdf',
      mime: 'application/pdf',
      content: demoPdf('TEST DATA - Contrat de travail'),
      documentDate: '2020-03-01',
      uploadedBy: admin,
    },
  ]);
}
