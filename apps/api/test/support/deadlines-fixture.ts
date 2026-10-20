import { createHash, randomUUID } from 'node:crypto';
import { query } from './test-database.js';

/**
 * Deadlines test data (docs/contracts/contracts-deadlines.md) written as the superuser: contracts, employee files with
 * an expiry date (a `document_expiry` item that exists whatever the contracts), and acknowledgements. TEST DATA.
 */

export async function insertContract(
  url: string,
  c: { companyId: string; employmentId: string; seq: number; contractType: string; startDate: string; endDate: string | null; probationEnd?: string | null },
): Promise<string> {
  const [row] = await query<{ id: string }>(
    url,
    `insert into employment_contract (company_id, employment_id, seq, kind, contract_type, start_date, end_date, probation_end)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [c.companyId, c.employmentId, c.seq, c.seq === 1 ? 'initial' : 'renewal', c.contractType, c.startDate, c.endDate, c.probationEnd ?? null],
  );
  if (!row) throw new Error('contract not inserted');
  return row.id;
}

/** An employee-file row (no bytes needed by the deadlines) expiring on `expiresOn`, in category `categoryCode`. */
export async function insertExpiringFile(
  url: string,
  f: { companyId: string; employmentId: string; uploadedBy: string; expiresOn: string; categoryCode?: string; title?: string },
): Promise<string> {
  const [category] = await query<{ id: string }>(url, 'select id from employee_file_category where company_id = $1 and code = $2', [f.companyId, f.categoryCode ?? 'id_document']);
  if (!category) throw new Error(`no employee-file category ${f.categoryCode ?? 'id_document'}`);
  const id = randomUUID();
  await query(
    url,
    `insert into employee_file (id, company_id, employment_id, category_id, title, original_filename, mime, size_bytes, sha256, uploaded_by, expires_on)
     values ($1, $2, $3, $4, $5, 'piece.pdf', 'application/pdf', 100, $6, $7, $8)`,
    [id, f.companyId, f.employmentId, category.id, f.title ?? 'Pièce test', createHash('sha256').update(id).digest(), f.uploadedBy, f.expiresOn],
  );
  return id;
}

export async function insertAck(url: string, a: { companyId: string; kind: string; subjectId: string; dueDate: string; ackedBy: string }): Promise<string> {
  const [row] = await query<{ id: string }>(
    url,
    'insert into deadline_ack (company_id, kind, subject_id, due_date, acked_by) values ($1, $2, $3, $4, $5) returning id',
    [a.companyId, a.kind, a.subjectId, a.dueDate, a.ackedBy],
  );
  if (!row) throw new Error('ack not inserted');
  return row.id;
}

export function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
