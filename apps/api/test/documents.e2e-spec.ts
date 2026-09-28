/**
 * Documents, Phase A (docs/contracts/documents.md, ADR 008) against the real grants (DEV_AUTH header identity, no
 * DEV_PERMISSIONS), the real Typst renderer and the demo seed: issuing and its preconditions, the stored PDF (PDF/A,
 * Arabic text, identical reprints), gap-free numbering under concurrency with injected render failures, year
 * rollover, clientRequestId replays, number collisions, void, scope, settings, self-service requests through the
 * workflow engine with their notifications, the timeline, and the audit rows of every write.
 * "Today" is pinned (DocumentsClock / LeaveClock / StaffingClock).
 */
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoLogoPng, DocumentsClock } from '../src/modules/documents/index.js';
import { LEAVE_DEMO, LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { PdfRenderError, PdfRenderer, TypstPdfRenderer, type RenderInput } from '../src/platform/pdf/index.js';
import { as, COMPANY_A, COMPANY_B, demoEmployee, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const clock = { value: '2026-09-28', today(): string { return this.value; } };
const pinned = { today: () => '2026-09-28' };

/**
 * A renderer that fails at random (the gap-free test) — plus every third call, so failures always happen — and
 * delegates to the real one otherwise.
 */
class FlakyRenderer extends PdfRenderer {
  static failureRate = 0;
  private calls = 0;
  private readonly real = new TypstPdfRenderer();
  readonly engine = this.real.engine;
  render(input: RenderInput): Promise<Buffer> {
    this.calls += 1;
    if (FlakyRenderer.failureRate > 0 && (this.calls % 3 === 0 || Math.random() < FlakyRenderer.failureRate)) return Promise.reject(new PdfRenderError('error', 'injected failure'));
    return this.real.render(input);
  }
  onModuleDestroy(): Promise<void> {
    return this.real.close();
  }
}

interface DocView {
  id: string;
  number: string;
  status: string;
  language: string;
  issueDate: string;
  sha256: string;
  sizeBytes: number;
  employee: { id: string; matricule: string };
  signatory: { id: string };
  void: { reason: string } | null;
  warnings: string[];
  _actions: string[];
  snapshot?: Record<string, unknown> & { employee: Record<string, unknown>; leave?: Record<string, unknown> };
}

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let annualType = '';

const client = (actor: ActorName) => as(app, actor, xsrf);

function binary(res: Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function pdfOf(actor: ActorName, path: string, status = 200): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const res = await client(actor).get(path).buffer(true).parse(binary);
  expect(res.status, JSON.stringify(res.body instanceof Buffer ? res.body.toString('utf8').slice(0, 300) : res.body)).toBe(status);
  return { body: res.body as Buffer, headers: res.headers as Record<string, string> };
}

async function textOf(pdf: Buffer): Promise<string> {
  return (await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true })).text;
}

async function issue(actor: ActorName, body: object, status = 201): Promise<DocView> {
  const res = await client(actor).post('/api/documents').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as DocView;
}

async function approvedLeave(n: number, employment: string, unitCode: string, start: string, end: string, status = 'approved', halfDayEnd = false): Promise<string> {
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, half_day_end, status, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [COMPANY_A, employment, annualType, unitA(unitCode), start, end, n, halfDayEnd, status, USERS.admin.id],
  );
  return row?.id ?? '';
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, '2026-09-28', { leave: true, documents: true });
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    overrides: [
      { provide: DocumentsClock, useValue: clock },
      { provide: LeaveClock, useValue: pinned },
      { provide: StaffingClock, useValue: pinned },
    ],
  });
  xsrf = await fetchXsrf(app);
  annualType = (await query<{ id: string }>(db.superuserUrl, `select id from leave_type where company_id = $1 and code = 'annual'`, [COMPANY_A]))[0]?.id ?? '';
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('issuing (HR)', () => {
  it('issues an attestation: 201 + Location, number ATT-2026-00001, the view, the stored PDF with the contract headers', async () => {
    const res = await client('est').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' }).expect(201);
    const doc = res.body as DocView;
    assertNoSecrets(doc);
    expect(res.headers['location']).toBe(`/api/documents/${doc.id}`);
    expect(doc).toMatchObject({ number: 'ATT-2026-00001', status: 'issued', language: 'fr', issueDate: '2026-09-28', employee: { matricule: 'EMP-0027' }, warnings: [], _actions: [] });
    const pdf = await pdfOf('est', `/api/documents/${doc.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="ATT-2026-00001.pdf"');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    expect(pdf.headers['x-document-status']).toBe('issued');
    expect(pdf.headers['etag']).toBe(`"${doc.sha256}"`);
    expect(pdf.body.length).toBe(doc.sizeBytes);
    // PDF/A-2b, the vendored fonts only, the facts printed
    const raw = pdf.body.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toMatch(/pdfaid:part(>|=")2/);
    expect(raw).toMatch(/pdfaid:conformance(>|=")B/);
    expect(raw).toMatch(/SourceSans3/);
    const text = await textOf(pdf.body);
    const e = demoEmployee(27);
    for (const expected of ['ATT-2026-00001', 'ATTESTATION DE TRAVAIL', e.lastName, 'EMP-0027', 'Souad Cherif', 'Fait à Alger, le 28 septembre 2026']) expect(text).toContain(expected);
    // the snapshot is what was printed; never the salary
    const detail = (await client('est').get(`/api/documents/${doc.id}`).expect(200)).body as DocView;
    expect(detail.snapshot).toMatchObject({ number: 'ATT-2026-00001', lang: 'fr', signatory: { name: 'Souad Cherif' }, employee: { matricule: 'EMP-0027' } });
    expect(JSON.stringify(detail.snapshot)).not.toMatch(/salary|salaire|base_salary/i);
  });

  it('a reprint returns identical bytes, every download is audited', async () => {
    const [doc] = (await client('admin').get('/api/documents?typeCode=attestation_travail&q=ATT-2026-00001').expect(200)).body.items as DocView[];
    const a = await pdfOf('admin', `/api/documents/${doc?.id}/pdf?disposition=inline`);
    const b = await pdfOf('admin', `/api/documents/${doc?.id}/pdf`);
    expect(a.body.equals(b.body)).toBe(true);
    expect(a.headers['content-disposition']).toMatch(/^inline;/);
    const events = await query<{ data: { disposition: string; via: string } }>(db.superuserUrl, `select data from audit.event where type = 'document.downloaded' and subject_id = $1`, [doc?.id]);
    expect(events.map((e) => e.data.disposition).toSorted()).toEqual(['attachment', 'attachment', 'inline']);
  });

  it('renders Arabic: Arabic words in logical order, the Latin matricule and the number, PDF/A', async () => {
    const doc = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(31), language: 'ar' });
    expect(doc.number).toBe('ATT-2026-00002');
    const detail = (await client('admin').get(`/api/documents/${doc.id}`).expect(200)).body as DocView;
    const e = demoEmployee(31);
    const fullName = `${e.firstNameAr ?? e.firstName} ${e.lastNameAr ?? e.lastName}`;
    expect(detail.snapshot?.employee['fullName']).toBe(fullName);
    expect(detail.snapshot?.['issueDateText']).toBe('28 سبتمبر 2026');
    const pdf = await pdfOf('admin', `/api/documents/${doc.id}/pdf`);
    expect(pdf.body.toString('latin1')).toMatch(/pdfaid:part(>|=")2/);
    expect(pdf.body.toString('latin1')).toMatch(/Cairo/);
    const text = await textOf(pdf.body);
    // word by word (each word's letters in logical order; line order is the viewer's business)
    const words = text.split(/\s+/);
    for (const word of [...fullName.split(' '), 'شهادة', 'عمل', 'مؤسستنا', 'سعاد']) expect(words.some((w) => w.includes(word)), `${word} in ${text}`).toBe(true);
    expect(text).toContain('ATT-2026-00002');
    expect(text).toContain('EMP-0031');
  });

  it('previews without a number, a row or an audit event (SPÉCIMEN)', async () => {
    const before = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from issued_document`);
    const res = await client('est')
      .post('/api/documents/preview')
      .send({ typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' })
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const text = await textOf(res.body as Buffer);
    expect(text).toContain('ATT-2026-…');
    expect(text).toContain('SPÉCIMEN');
    expect(await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from issued_document`)).toEqual(before);
  });

  it('preconditions: ended / not ended employment, approved leave only, incomplete letterhead, signatory, body shape', async () => {
    await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(25), language: 'fr' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-employment-ended'));
    await client('admin').post('/api/documents').send({ typeCode: 'certificat_travail', employmentId: employeeA(27), language: 'fr' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-employment-not-ended'));
    const cert = await issue('admin', { typeCode: 'certificat_travail', employmentId: employeeA(25), language: 'fr' });
    expect(cert.number).toBe('CT-2026-00001');
    expect(await textOf((await pdfOf('admin', `/api/documents/${cert.id}/pdf`)).body)).toContain('est libre de tout engagement');
    const pending = await approvedLeave(2, employeeA(27), 'AG-CNE', '2026-10-05', '2026-10-06', 'pending');
    await client('admin').post('/api/documents').send({ typeCode: 'titre_conge', leaveRequestId: pending, language: 'fr' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-leave-not-approved'));
    await client('admin').post('/api/documents').send({ typeCode: 'titre_conge', employmentId: employeeA(27), language: 'fr' }).expect(422);
    await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(27), leaveRequestId: pending, language: 'fr' }).expect(422);
    // BETA's letterhead has no Arabic
    const res = await client('beta').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: EMPLOYEE_B.employmentId, language: 'ar' }).expect(409);
    expect(res.body.type).toBe('urn:hrforce:problem:document-profile-incomplete');
    expect((res.body.errors as { field: string }[]).map((e) => e.field)).toEqual(['legalNameAr', 'addressAr', 'cityAr']);
    // the Région Est director does not sign for Oran
    const sig = await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(36), language: 'fr', signatoryId: '0190a5d0-0000-7000-8020-000000000002' }).expect(422);
    expect(sig.body.errors[0]).toMatchObject({ field: 'signatoryId', code: 'invalid_signatory' });
  });

  it('titre de congé from an approved leave: the leave facts and the resumption day', async () => {
    // Thursday 2026-10-15 (weekend Fri + Sat) → resumption Sunday 2026-10-18
    const leave = await approvedLeave(4, employeeA(27), 'AG-CNE', '2026-10-12', '2026-10-15');
    const doc = await issue('est', { typeCode: 'titre_conge', leaveRequestId: leave, language: 'fr' });
    expect(doc.number).toBe('TC-2026-00001');
    const detail = (await client('est').get(`/api/documents/${doc.id}`).expect(200)).body as DocView;
    expect(detail.snapshot?.leave).toMatchObject({ typeLabel: 'Congé annuel', startText: '12 octobre 2026', endText: '15 octobre 2026', days: '4', resumptionText: '18 octobre 2026' });
    const text = await textOf((await pdfOf('est', `/api/documents/${doc.id}/pdf`)).body);
    expect(text).toContain('TITRE DE CONGÉ');
    expect(text).toContain('18 octobre 2026');
    // a cancelled leave flags its titre (not voided automatically)
    await query(db.superuserUrl, `update leave_request set status = 'cancelled' where id = $1`, [leave]);
    const [flagged] = (await client('est').get(`/api/documents?leaveRequestId=${leave}`).expect(200)).body.items as DocView[];
    expect(flagged?.warnings).toEqual(['leave-cancelled']);
  });

  it('clientRequestId: a replay returns 200 with the same document (no new number); another body → 409', async () => {
    const clientRequestId = '0190a5d0-0000-7000-9000-00000000c001';
    const body = { typeCode: 'attestation_travail', employmentId: employeeA(28), language: 'fr', clientRequestId };
    const first = await issue('admin', body);
    const replay = await client('admin').post('/api/documents').send(body).expect(200);
    expect((replay.body as DocView).id).toBe(first.id);
    expect(replay.headers['location']).toBe(`/api/documents/${first.id}`);
    const reused = await client('admin').post('/api/documents').send({ ...body, language: 'ar' }).expect(409);
    expect(reused.body.type).toBe('urn:hrforce:problem:document-client-request-reused');
    const [seq] = await query<{ last_value: number }>(db.superuserUrl, `select s.last_value from document_sequence s join document_type t on t.id = s.document_type_id where t.company_id = $1 and t.code = 'attestation_travail' and s.year = 2026`, [COMPANY_A]);
    expect(seq?.last_value).toBe(Number(first.number.slice(-5)));
  });

  it('void keeps the number (never reused) and the file; only admin_rh_central voids', async () => {
    const doc = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(29), language: 'fr' });
    await client('est').post(`/api/documents/${doc.id}/void`).send({ reason: 'Erreur' }).expect(403);
    await client('admin').post(`/api/documents/${doc.id}/void`).send({ reason: 'x' }).expect(422);
    const voided = (await client('admin').post(`/api/documents/${doc.id}/void`).send({ reason: 'Erreur de saisie' }).expect(200)).body as DocView;
    expect(voided).toMatchObject({ number: doc.number, status: 'void', void: { reason: 'Erreur de saisie' }, _actions: [] });
    await client('admin').post(`/api/documents/${doc.id}/void`).send({ reason: 'Encore' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-already-void'));
    const pdf = await pdfOf('admin', `/api/documents/${doc.id}/pdf`);
    expect(pdf.headers['x-document-status']).toBe('void');
    const next = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(29), language: 'fr' });
    expect(Number(next.number.slice(-5))).toBe(Number(doc.number.slice(-5)) + 1);
    // the database refuses anything but issued → void, and any delete
    await expect(query(db.superuserUrl, `update issued_document set number = 'X' where id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(query(db.superuserUrl, `update issued_document set status = 'issued', voided_by = null, voided_at = null, void_reason = null where id = $1`, [doc.id])).rejects.toThrow(/issued → void/);
    await expect(query(db.superuserUrl, `update document_sequence set last_value = last_value + 5`)).rejects.toThrow(/forward/);
  });
});

describe('scope', () => {
  it('regional HR issues and reads inside its region only; lecture and admin_acces see nothing', async () => {
    const ouest = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(36), language: 'fr' });
    await client('est').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(36), language: 'fr' }).expect(404);
    await client('est').get(`/api/documents/${ouest.id}`).expect(404);
    await client('est').get(`/api/documents/${ouest.id}/pdf`).expect(404);
    const page = (await client('est').get('/api/documents?pageSize=100').expect(200)).body as { items: DocView[]; total: number };
    expect(page.items.length).toBe(page.total);
    const estUnits = new Set(['AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB', 'SRV-ADM-EST', 'REG-EST'].map(unitA));
    expect(page.items.every((d) => estUnits.has((d.employee as unknown as { unit: { id: string } }).unit.id))).toBe(true);
    for (const actor of ['ouest', 'acces'] as const) {
      await client(actor).get('/api/documents').expect(403);
      await client(actor).get(`/api/documents/${ouest.id}`).expect(403);
      await client(actor).post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(36), language: 'fr' }).expect(403);
    }
    await client('beta').get(`/api/documents/${ouest.id}`).expect(404);
    // HR of the employee's region sees the whole history; the timeline follows document.read
    await client('est').get(`/api/audit/timeline?subject=issued_document:${ouest.id}`).expect(404);
    const timeline = (await client('admin').get(`/api/audit/timeline?subject=issued_document:${ouest.id}`).expect(200)).body as { items: { kind: string; event?: { type: string }; table?: string }[] };
    expect(timeline.items.some((i) => i.event?.type === 'document.issued')).toBe(true);
    expect(timeline.items.some((i) => i.table === 'issued_document')).toBe(true);
  });
});

describe('numbering', () => {
  it('gap-free under 20 concurrent issues with random render failures: numbers 1..k, last_value = k, a file for each', async () => {
    const flaky = await createTestApp(db, {
      devAuth: true,
      devPermissions: false,
      overrides: [
        { provide: DocumentsClock, useValue: { today: () => '2031-03-02' } },
        { provide: LeaveClock, useValue: pinned },
        { provide: StaffingClock, useValue: pinned },
        { provide: PdfRenderer as unknown as Type<PdfRenderer>, useValue: new FlakyRenderer() },
      ],
    });
    try {
      FlakyRenderer.failureRate = 0.2;
      const employees = [22, 26, 27, 28, 29, 30, 31, 32, 33].map(employeeA);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          as(flaky, 'admin', xsrf).post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employees[i % employees.length], language: i % 2 ? 'ar' : 'fr' }),
        ),
      );
      FlakyRenderer.failureRate = 0;
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 201 || s === 503), JSON.stringify(results.map((r) => r.body))).toBe(true);
      expect(results.filter((r) => r.status === 503).every((r) => r.body.type === 'urn:hrforce:problem:document-render-failed')).toBe(true);
      const k = statuses.filter((s) => s === 201).length;
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThanOrEqual(14); // at least every third render failed
      const rows = await query<{ seq: number; number: string; has_file: boolean }>(
        db.superuserUrl,
        `select d.seq, d.number, exists (select 1 from issued_document_file f where f.document_id = d.id) as has_file
           from issued_document d where d.company_id = $1 and d.type_code = 'attestation_travail' and d.year = 2031 order by d.seq`,
        [COMPANY_A],
      );
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: k }, (_, i) => i + 1));
      expect(new Set(rows.map((r) => r.number)).size).toBe(k);
      expect(rows.every((r) => r.has_file)).toBe(true);
      const [seq] = await query<{ last_value: number }>(db.superuserUrl, `select s.last_value from document_sequence s join document_type t on t.id = s.document_type_id where t.company_id = $1 and t.code = 'attestation_travail' and s.year = 2031`, [COMPANY_A]);
      expect(seq?.last_value).toBe(k);
    } finally {
      FlakyRenderer.failureRate = 0;
      await flaky.close();
    }
  }, 120_000);

  it('year rollover: 31 December then 1 January restarts at 1', async () => {
    clock.value = '2032-12-31';
    try {
      const dec = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' });
      expect(dec.number).toBe('ATT-2032-00001');
      expect(dec.issueDate).toBe('2032-12-31');
      clock.value = '2033-01-01';
      const jan = await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' });
      expect(jan.number).toBe('ATT-2033-00001');
      const types = (await client('admin').get('/api/documents/types').expect(200)).body.items as { code: string; nextNumber: string }[];
      expect(types.find((t) => t.code === 'attestation_travail')?.nextNumber).toBe('ATT-2033-00002');
    } finally {
      clock.value = '2026-09-28';
    }
  });

  it('a format producing an existing number → 409 document-number-taken, rolled back with its counter', async () => {
    clock.value = '2034-02-01';
    const types = (await client('admin').get('/api/documents/types').expect(200)).body.items as { id: string; code: string }[];
    const certificat = types.find((t) => t.code === 'certificat_travail')?.id ?? '';
    try {
      expect((await issue('admin', { typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' })).number).toBe('ATT-2034-00001');
      await client('admin').put(`/api/documents/types/${certificat}`).send({ numberFormat: 'ATT-{YYYY}-0{SEQ:4}' }).expect(200);
      const res = await client('admin').post('/api/documents').send({ typeCode: 'certificat_travail', employmentId: employeeA(25), language: 'fr' }).expect(409);
      expect(res.body.type).toBe('urn:hrforce:problem:document-number-taken');
      expect(await query(db.superuserUrl, `select 1 from document_sequence where document_type_id = $1 and year = 2034`, [certificat])).toEqual([]);
    } finally {
      await client('admin').put(`/api/documents/types/${certificat}`).send({ numberFormat: 'CT-{YYYY}-{SEQ:5}' }).expect(200);
      clock.value = '2026-09-28';
    }
  });
});

describe('settings', () => {
  it('letterhead, logo (sniffed, ≤ 256 KB), signatories, types — company-wide document.configure', async () => {
    const profile = (await client('beta').get('/api/documents/settings/profile').expect(200)).body as { complete: { fr: boolean; ar: boolean }; hasLogo: boolean };
    expect(profile.complete).toEqual({ fr: true, ar: false });
    const saved = await client('beta')
      .put('/api/documents/settings/profile')
      .send({ legalNameFr: 'Beta SARL', legalNameAr: 'بيتا ش.ذ.م.م', addressFr: '1 rue de Sétif', addressAr: '1 شارع سطيف', cityFr: 'Sétif', cityAr: 'سطيف', nif: '000019 test', email: 'rh@beta.dz' })
      .expect(200);
    expect(saved.body).toMatchObject({ nif: '000019 TEST', complete: { fr: true, ar: true } });
    await client('beta').put('/api/documents/settings/profile').send({ legalNameFr: '', addressFr: 'x', cityFr: 'y' }).expect(422);
    // logo: PNG accepted, SVG and oversized refused (422, never 413)
    await client('beta').put('/api/documents/settings/profile/logo').set('Cookie', xsrf.cookie).attach('file', demoLogoPng(), { filename: 'logo.svg', contentType: 'image/svg+xml' }).expect(200);
    const logo = await client('beta').get('/api/documents/settings/profile/logo').buffer(true).parse(binary).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toBe('no-store');
    const svg = await client('beta').put('/api/documents/settings/profile/logo').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.png').expect(422);
    expect(svg.body.errors[0]).toMatchObject({ field: 'file', code: 'unsupported_type' });
    const big = await client('beta').put('/api/documents/settings/profile/logo').attach('file', Buffer.alloc(300 * 1024, 1), 'big.png').expect(422);
    expect(big.body.errors[0]).toMatchObject({ field: 'file', code: 'too_large' });
    // an Arabic document now renders with BETA's logo
    const doc = await issue('beta', { typeCode: 'attestation_travail', employmentId: EMPLOYEE_B.employmentId, language: 'ar' });
    expect(doc.number).toBe('ATT-2026-00001');
    await client('beta').delete('/api/documents/settings/profile/logo').expect(204);
    await client('beta').get('/api/documents/settings/profile/logo').expect(404);

    const created = (await client('admin').post('/api/documents/settings/signatories').send({ orgUnitId: unitA('REG-OUEST'), names: { fr: 'Nadir Ouest', ar: 'نذير الغرب' }, titles: { fr: 'Directeur', ar: 'مدير' } }).expect(201)).body as { id: string; unit: { code: string } };
    expect(created.unit.code).toBe('REG-OUEST');
    const cover = (await client('admin').get(`/api/documents/signatories?employmentId=${employeeA(36)}`).expect(200)).body.items as { id: string }[];
    expect(cover[0]?.id).toBe(created.id);
    await client('admin').patch(`/api/documents/settings/signatories/${created.id}`).send({ active: false }).expect(200).expect((r) => expect(r.body.active).toBe(false));
    await client('admin').post('/api/documents/settings/signatories').send({ orgUnitId: '0190a5d0-0000-7000-8000-00000000dead', names: { fr: 'X', ar: 'س' }, titles: { fr: 'X', ar: 'س' } }).expect(422);

    const types = (await client('admin').get('/api/documents/types').expect(200)).body.items as { id: string; code: string; numberFormat: string | null }[];
    const att = types.find((t) => t.code === 'attestation_travail')?.id ?? '';
    const ct = types.find((t) => t.code === 'certificat_travail')?.id ?? '';
    await client('admin').put(`/api/documents/types/${att}`).send({ numberFormat: 'ATT-{SEQ}' }).expect(422).expect((r) => expect(r.body.errors[0]).toMatchObject({ field: 'numberFormat', code: 'invalid_format' }));
    await client('admin').put(`/api/documents/types/${att}`).send({ numberFormat: 'CT-{YYYY}-{SEQ:5}' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-format-taken'));
    await client('admin').put(`/api/documents/types/${ct}`).send({ selfService: true }).expect(422);
    await client('admin').put(`/api/documents/types/${att}`).send({ defaultSignatoryId: '0190a5d0-0000-7000-8020-000000000001' }).expect(200).expect((r) => expect(r.body.defaultSignatoryId).toBe('0190a5d0-0000-7000-8020-000000000001'));
    // readers of the reference data do not see the formats
    const agentTypes = (await client('agent').get('/api/documents/types').expect(200)).body.items as { numberFormat: string | null; nextNumber: string | null }[];
    expect(agentTypes.every((t) => t.numberFormat === null && t.nextNumber === null)).toBe(true);
    await client('admin').put(`/api/documents/types/${att}`).send({ defaultSignatoryId: null }).expect(200);
  });
});

describe('self-service attestation requests', () => {
  interface Task { id: string; subject: { id: string; type: string; documentType?: { code: string }; language?: string } }
  const taskFor = async (actor: ActorName, requestId: string) =>
    ((await client(actor).get('/api/tasks').expect(200)).body.items as Task[]).find((t) => t.subject.id === requestId);

  it('request → HR approval issues in the same transaction → document.ready; the employee downloads it', async () => {
    const before = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from issued_document`);
    const created = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'ar', purpose: 'Dossier bancaire' }).expect(201)).body as { id: string; status: string; _actions: string[]; workflow: { steps: { key: string; state: string }[] } };
    expect(created).toMatchObject({ status: 'pending', _actions: ['cancel'], workflow: { steps: [{ key: 'hr', state: 'current' }] } });
    await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-request-pending'));
    await client('agent').post('/api/me/documents/requests').send({ typeCode: 'certificat_travail', language: 'fr' }).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-type-not-self-service'));
    // no number consumed before the approval
    expect(await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from issued_document`)).toEqual(before);
    const task = await taskFor('est', created.id);
    expect(task?.subject).toMatchObject({ type: 'document_request', documentType: { code: 'attestation_travail' }, language: 'ar' });
    const assigned = await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from notification where type = 'task.assigned' and subject_id = $1 and user_id = $2`, [task?.id, USERS.est.id]);
    expect(assigned[0]?.data).toMatchObject({ subjectType: 'document_request', documentType: 'attestation_travail' });
    expect(JSON.stringify(assigned[0]?.data)).not.toContain('Dossier bancaire');
    await client('est').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);
    const mine = (await client('agent').get('/api/me/documents').expect(200)).body as { documents: DocView[]; requests: { id: string; status: string; document: { id: string; number: string } | null }[] };
    const request = mine.requests.find((r) => r.id === created.id);
    expect(request?.status).toBe('approved');
    const doc = mine.documents.find((d) => d.id === request?.document?.id);
    expect(doc).toMatchObject({ language: 'ar', employee: { id: LEAVE_DEMO.agent.employmentId } });
    const [row] = await query<{ issued_by: string; document_request_id: string }>(db.superuserUrl, `select issued_by, document_request_id from issued_document where id = $1`, [doc?.id]);
    expect(row).toEqual({ issued_by: USERS.est.id, document_request_id: created.id });
    const ready = await query<{ user_id: string; subject_type: string; data: Record<string, unknown> }>(db.superuserUrl, `select user_id, subject_type, data from notification where type = 'document.ready' and subject_id = $1`, [doc?.id]);
    expect(ready).toEqual([expect.objectContaining({ user_id: USERS.agent.id, subject_type: 'issued_document' })]);
    expect(ready[0]?.data).toMatchObject({ number: doc?.number, documentType: 'attestation_travail', audience: 'employee' });
    const pdf = await pdfOf('agent', `/api/me/documents/${doc?.id}/pdf`);
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${doc?.number}.pdf"`);
    const event = await query<{ data: { via: string } }>(db.superuserUrl, `select data from audit.event where type = 'document.issued' and subject_id = $1`, [doc?.id]);
    expect(event[0]?.data.via).toBe('self_service');
    // someone else's document → 404; a void one → 404 through /me
    const [other] = (await client('admin').get(`/api/documents?employmentId=${employeeA(27)}`).expect(200)).body.items as DocView[];
    await client('agent').get(`/api/me/documents/${other?.id}/pdf`).expect(404);
  });

  it('rejection → document.rejected, no number; cancel; SoD: the requester cannot approve', async () => {
    const created = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body as { id: string };
    const task = await taskFor('admin', created.id);
    await client('admin').post(`/api/tasks/${task?.id}/reject`).send({ comment: 'Déjà délivrée ce mois-ci' }).expect(200);
    const mine = (await client('agent').get('/api/me/documents').expect(200)).body as { requests: { id: string; status: string; rejectionComment: string | null; document: unknown }[] };
    expect(mine.requests.find((r) => r.id === created.id)).toMatchObject({ status: 'rejected', rejectionComment: 'Déjà délivrée ce mois-ci', document: null });
    const rejected = await query<{ user_id: string }>(db.superuserUrl, `select user_id from notification where type = 'document.rejected' and subject_id = $1`, [created.id]);
    expect(rejected.map((r) => r.user_id)).toEqual([USERS.agent.id]);

    const again = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body as { id: string };
    await client('est').post(`/api/me/documents/requests/${again.id}/cancel`).expect(404);
    const cancelled = (await client('agent').post(`/api/me/documents/requests/${again.id}/cancel`).expect(200)).body as { status: string; _actions: string[] };
    expect(cancelled).toMatchObject({ status: 'cancelled', _actions: [] });
    await client('agent').post(`/api/me/documents/requests/${again.id}/cancel`).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-request-not-cancellable'));

    // Karim (rh.est) is linked to EMP-0022 and holds document.issue over his own unit: he cannot approve his own request
    const own = (await client('est').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body as { id: string };
    expect(await taskFor('est', own.id)).toBeUndefined();
    const adminTask = await taskFor('admin', own.id);
    const instance = await query<{ id: string }>(db.superuserUrl, `select instance_id as id from workflow_task where id = $1`, [adminTask?.id]);
    expect(instance.length).toBe(1);
    const [taskRow] = await query<{ id: string }>(db.superuserUrl, `select id from workflow_task where instance_id = $1 and status = 'open'`, [instance[0]?.id]);
    await client('est').post(`/api/tasks/${taskRow?.id}/approve`).send({}).expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:workflow-self-approval'));
    await client('admin').post(`/api/tasks/${adminTask?.id}/approve`).send({}).expect(200);
  });

  it('an issuing error fails the approval and rolls it back with its slug (the task stays open)', async () => {
    await query(db.superuserUrl, `update company_profile set legal_name_ar = null where company_id = $1`, [COMPANY_A]);
    try {
      const created = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'ar' }).expect(201)).body as { id: string };
      const task = await taskFor('est', created.id);
      const res = await client('est').post(`/api/tasks/${task?.id}/approve`).send({}).expect(409);
      expect(res.body.type).toBe('urn:hrforce:problem:document-profile-incomplete');
      expect(await taskFor('est', created.id)).toBeDefined();
      const [row] = await query<{ status: string }>(db.superuserUrl, `select status from document_request where id = $1`, [created.id]);
      expect(row?.status).toBe('pending');
      await client('agent').post(`/api/me/documents/requests/${created.id}/cancel`).expect(200);
    } finally {
      await query(db.superuserUrl, `update company_profile set legal_name_ar = 'مؤسسة هرفورس التجريبية' where company_id = $1`, [COMPANY_A]);
    }
  });

  it('not linked → 409 document-not-linked', async () => {
    await client('admin').get('/api/me/documents').expect(409).expect((r) => expect(r.body.type).toBe('urn:hrforce:problem:document-not-linked'));
  });
});

describe('audit', () => {
  it('every write of the slice left row-level audit rows and the application events', async () => {
    const tables = await query<{ table_name: string }>(db.superuserUrl, `select distinct table_name from audit.change_log where table_name in ('company_profile', 'document_signatory', 'document_type', 'issued_document', 'document_request') order by 1`);
    expect(tables.map((t) => t.table_name)).toEqual(['company_profile', 'document_request', 'document_signatory', 'document_type', 'issued_document']);
    const events = await query<{ type: string }>(db.superuserUrl, `select distinct type from audit.event where type like 'document.%' order by 1`);
    expect(events.map((e) => e.type)).toEqual(['document.downloaded', 'document.issued', 'document.voided']);
    // the logo's bytes are masked in the diff; the counter and the PDF bytes are not audited (exempt)
    const logo = await query<{ after: Record<string, unknown> }>(db.superuserUrl, `select after from audit.change_log where table_name = 'company_profile' and after ->> 'logo' is not null limit 1`);
    expect(logo[0]?.after['logo']).toBe('***');
    expect(await query(db.superuserUrl, `select 1 from audit.change_log where table_name in ('document_sequence', 'issued_document_file') limit 1`)).toEqual([]);
    // the voiding actor is recorded
    const voided = await query<{ actor_user_id: string }>(db.superuserUrl, `select actor_user_id from audit.event where type = 'document.voided'`);
    expect(voided.every((v) => v.actor_user_id === USERS.admin.id)).toBe(true);
    expect(COMPANY_B).toBeTruthy();
  });
});
