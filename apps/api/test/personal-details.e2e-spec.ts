/**
 * Personal details (docs/contracts/profile-changes.md › Employment additions): HR edits of contact, emergency contact
 * and family (children added / updated / deleted), validation paths, scope and permissions, the detail's `personal`
 * block and its redaction, ended employments, the database backstops of migration 0025, and audit masking (no phone,
 * e-mail, address or child name value in audit.change_log). Real grants over the seeded demo employees (test data).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, COMPANY_A, EMPLOYEE_B, demoEmployee, employeeA, seedAccessFixture, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { demoEmployees, seedDemoPersonal, seedProfileDefaults } from '../src/modules/employment/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName) => as(app, actor, xsrf);

/** EMP-0028 (Agence Constantine, Région Est), EMP-0036 (Région Ouest), EMP-0025 (Région Est, ended). */
const EST = employeeA(28);
const OUEST = employeeA(36);
const ENDED = employeeA(25);

const CONTACT = {
  mobilePhone: '0555 98 76 54',
  otherPhone: '+33 6 12 34 56 78',
  personalEmail: 'Amel.Test@Exemple.TEST',
  addressLine: '12, rue des Glycines',
  commune: 'El Khroub',
  wilayaCode: '25',
  postalCode: '25100',
};

const family = (children: unknown[], over: Record<string, unknown> = {}) => ({ maritalStatus: 'married', maritalStatusSince: '2016-07-01', spouseEmployed: 'no', children, ...over });

async function changeLog(table: string, personOrRow?: string): Promise<{ op: string; row_id: string; before: unknown; after: unknown; changed: string[]; actor_user_id: string | null }[]> {
  return query(
    db.superuserUrl,
    `select op, row_id::text, before, after, changed, actor_user_id::text from audit.change_log where company_id = $1 and table_name = $2 ${personOrRow ? 'and row_id = $3' : ''} order by at, id`,
    personOrRow ? [COMPANY_A, table, personOrRow] : [COMPANY_A, table],
  );
}

/** A statement as hrforce_app inside COMPANY_A (RLS applies). */
async function inTenant(text: string, values: unknown[] = []): Promise<unknown[]> {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.company_id', $1, true)`, [COMPANY_A]);
    const rows = (await c.query(text, values)).rows as unknown[];
    await c.query('commit');
    return rows;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db);
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('GET /api/employees/:id — personal block', () => {
  it('admin and rh.est get `personal` (empty when nothing is recorded) and update_personal; lecture gets it redacted', async () => {
    const admin = await client('admin').get(`/api/employees/${EST}`).expect(200);
    expect(admin.body.personal).toEqual({
      contact: { mobilePhone: null, otherPhone: null, personalEmail: null, addressLine: null, commune: null, wilayaCode: null, postalCode: null, updatedAt: null },
      emergencyContact: null,
      family: { maritalStatus: null, maritalStatusSince: null, spouseEmployed: null, children: [] },
    });
    expect(admin.body['_actions']).toContain('update_personal');
    const est = await client('est').get(`/api/employees/${EST}`).expect(200);
    expect(est.body).toHaveProperty('personal');
    expect(est.body['_redacted']).not.toContain('personal');
    expect(est.body['_actions']).toContain('update_personal');
    const ouest = await client('ouest').get(`/api/employees/${OUEST}`).expect(200);
    expect(ouest.body).not.toHaveProperty('personal');
    expect(ouest.body['_redacted']).toEqual(['salary', 'bank', 'nss', 'personal']);
    expect(ouest.body['_actions']).toEqual([]);
  });

  it('an ended employment shows the block but offers no update_personal', async () => {
    const res = await client('admin').get(`/api/employees/${ENDED}`).expect(200);
    expect(res.body).toHaveProperty('personal');
    expect(res.body['_actions']).toEqual([]);
  });
});

describe('PUT /api/employees/:id/contact', () => {
  it('rh.est records the contact in its region: normalised phones and e-mail, updatedAt set; the list carries no personal data', async () => {
    const res = await client('est').put(`/api/employees/${EST}/contact`).send(CONTACT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoSecrets(res.body);
    expect(res.body.contact).toMatchObject({ ...CONTACT, mobilePhone: '+213555987654', otherPhone: '+33612345678', personalEmail: 'amel.test@exemple.test' });
    expect(typeof res.body.contact.updatedAt).toBe('string');
    const detail = await client('admin').get(`/api/employees/${EST}`).expect(200);
    expect(detail.body.personal.contact.mobilePhone).toBe('+213555987654');
    const list = await client('admin').get('/api/employees?pageSize=100').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('+213555987654');
    expect(list.body.items[0]).not.toHaveProperty('personal');
    const [row] = await query<{ updated_by: string }>(db.superuserUrl, 'select updated_by::text from person_contact where person_id = $1', [demoEmployee(28).personId]);
    expect(row?.updated_by).toBeTruthy();
  });

  it('the same values again write nothing (no new audit row); clearing every field keeps the row with nulls', async () => {
    const before = (await changeLog('person_contact', demoEmployee(28).personId)).length;
    await client('est').put(`/api/employees/${EST}/contact`).send(CONTACT).expect(200);
    expect((await changeLog('person_contact', demoEmployee(28).personId)).length).toBe(before);
    const cleared = await client('admin')
      .put(`/api/employees/${employeeA(27)}/contact`)
      .send({ mobilePhone: '', otherPhone: null, personalEmail: ' ', addressLine: null, commune: null, wilayaCode: '9', postalCode: null })
      .expect(200);
    expect(cleared.body.contact).toMatchObject({ mobilePhone: null, personalEmail: null, wilayaCode: '09' });
  });

  it('validation → 422 with field paths', async () => {
    const res = await client('admin')
      .put(`/api/employees/${EST}/contact`)
      .send({ mobilePhone: '12-34', otherPhone: null, personalEmail: 'nope@', addressLine: 'x'.repeat(201), commune: null, wilayaCode: '59', postalCode: '2510' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual([
      'mobilePhone:invalid_phone',
      'personalEmail:invalid_email',
      'addressLine:too_big',
      'wilayaCode:invalid_wilaya',
      'postalCode:invalid_postal_code',
    ]);
    const missing = await client('admin').put(`/api/employees/${EST}/contact`).send({ mobilePhone: null });
    expect(missing.status).toBe(422);
  });

  it('scope and permissions: rh.est outside its region → 404, lecture / access admin → 403, other company → 404, ended → 409', async () => {
    await client('est').put(`/api/employees/${OUEST}/contact`).send(CONTACT).expect(404);
    await client('ouest').put(`/api/employees/${OUEST}/contact`).send(CONTACT).expect(403);
    await client('acces').put(`/api/employees/${EST}/contact`).send(CONTACT).expect(403);
    await client('admin').put(`/api/employees/${EMPLOYEE_B.employmentId}/contact`).send(CONTACT).expect(404);
    await client('admin').put('/api/employees/not-a-uuid/contact').send(CONTACT).expect(404);
    const ended = await client('admin').put(`/api/employees/${ENDED}/contact`).send(CONTACT);
    expect(ended.status).toBe(409);
    expect(ended.body.type).toBe('urn:hrforce:problem:employment-ended');
    await as(app, null, xsrf).put(`/api/employees/${EST}/contact`).send(CONTACT).expect(401);
  });
});

describe('PUT /api/employees/:id/emergency-contact', () => {
  it('sets, changes and removes (body null) the emergency contact', async () => {
    const set = await client('admin').put(`/api/employees/${EST}/emergency-contact`).send({ fullName: 'Samir Testeur', relationship: 'sibling', phone: '0661 11 22 33' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.emergencyContact).toEqual({ fullName: 'Samir Testeur', relationship: 'sibling', phone: '+213661112233' });
    const removed = await client('est').put(`/api/employees/${EST}/emergency-contact`).set('Content-Type', 'application/json').send('null');
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.emergencyContact).toBeNull();
    expect(await query(db.superuserUrl, 'select 1 from person_emergency_contact where person_id = $1', [demoEmployee(28).personId])).toHaveLength(0);
    // removing an absent contact is a no-op
    await client('est').put(`/api/employees/${EST}/emergency-contact`).set('Content-Type', 'application/json').send('null').expect(200);
  });

  it('validation → 422 (relationship, phone, name)', async () => {
    const res = await client('admin').put(`/api/employees/${EST}/emergency-contact`).send({ fullName: '', relationship: 'cousin', phone: 'abc' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(['fullName', 'relationship', 'phone']);
  });
});

describe('PUT /api/employees/:id/family', () => {
  it('adds, updates and deletes children through the full list', async () => {
    const first = await client('est')
      .put(`/api/employees/${EST}/family`)
      .send(family([
        { firstName: 'Rania', birthDate: '2017-04-12', sex: 'F', dependent: true },
        { firstName: 'Ilyes', birthDate: '2019-09-30', sex: 'M', dependent: true },
      ]));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.family).toMatchObject({ maritalStatus: 'married', maritalStatusSince: '2016-07-01', spouseEmployed: 'no' });
    const [rania, ilyes] = first.body.family.children as { id: string; firstName: string }[];
    expect([rania?.firstName, ilyes?.firstName]).toEqual(['Rania', 'Ilyes']);

    const second = await client('est')
      .put(`/api/employees/${EST}/family`)
      .send(family([
        { id: rania?.id, firstName: 'Rania', birthDate: '2017-04-12', sex: 'F', dependent: false },
        { firstName: 'Nour', birthDate: '2024-01-05', sex: null, dependent: true },
      ]));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.family.children).toEqual([
      { id: rania?.id, firstName: 'Rania', birthDate: '2017-04-12', sex: 'F', dependent: false },
      { id: expect.any(String), firstName: 'Nour', birthDate: '2024-01-05', sex: null, dependent: true },
    ]);
    expect(await query(db.superuserUrl, 'select 1 from person_child where id = $1', [ilyes?.id])).toHaveLength(0);
    const ops = (await changeLog('person_child')).map((r) => r.op);
    expect(ops).toEqual(['insert', 'insert', 'delete', 'update', 'insert']);

    const detail = await client('admin').get(`/api/employees/${EST}`).expect(200);
    expect(detail.body.personal.family.children).toHaveLength(2);
  });

  it('rules: future dates, a date without status, an unknown child id, more than 15 children → 422 with paths', async () => {
    const res = await client('admin')
      .put(`/api/employees/${EST}/family`)
      .send(family([
        { firstName: 'Futur', birthDate: '2099-01-01', sex: 'M', dependent: true },
        { id: '0190a5d0-0000-7000-8e01-00000000ffff', firstName: 'X', birthDate: '2010-01-01', sex: null, dependent: true },
      ], { maritalStatus: null, maritalStatusSince: '2099-01-01' }));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual([
      'maritalStatusSince:status_required',
      'maritalStatusSince:future_date',
      'children.0.birthDate:future_date',
      'children.1.id:not_found',
    ]);
    const many = Array.from({ length: 16 }, (_, i) => ({ firstName: `Enfant ${i}`, birthDate: '2010-01-01', sex: null, dependent: true }));
    const tooMany = await client('admin').put(`/api/employees/${EST}/family`).send(family(many));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors).toEqual([expect.objectContaining({ field: 'children', code: 'too_many' })]);
    const shape = await client('admin').put(`/api/employees/${EST}/family`).send(family([{ firstName: '', birthDate: 'x', sex: 'X', dependent: 'yes' }], { maritalStatus: 'engaged' }));
    expect(shape.status).toBe(422);
    expect(shape.body.errors.map((e: { field: string }) => e.field)).toEqual(['maritalStatus', 'children.0.firstName', 'children.0.birthDate', 'children.0.sex', 'children.0.dependent']);
    // nothing changed
    expect((await client('admin').get(`/api/employees/${EST}`).expect(200)).body.personal.family.children).toHaveLength(2);
  });

  it('a child id of another person is not found', async () => {
    const other = await client('admin').put(`/api/employees/${employeeA(27)}/family`).send(family([{ firstName: 'Sami', birthDate: '2012-02-02', sex: 'M', dependent: true }])).expect(200);
    const id = (other.body.family.children as { id: string }[])[0]?.id;
    const res = await client('admin').put(`/api/employees/${EST}/family`).send(family([{ id, firstName: 'Sami', birthDate: '2012-02-02', sex: 'M', dependent: true }]));
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'children.0.id', code: 'not_found' })]);
  });
});

describe('database backstops (migration 0025)', () => {
  it('formats, 15 children, no DELETE of contact / family rows for the app role', async () => {
    const person = demoEmployee(30).personId;
    await expect(query(db.superuserUrl, `insert into person_contact (person_id, company_id, mobile_phone) values ($1, $2, '0555 12 34 56')`, [person, COMPANY_A])).rejects.toThrow(/person_contact_mobile_ck/);
    await expect(query(db.superuserUrl, `insert into person_contact (person_id, company_id, wilaya_code) values ($1, $2, '59')`, [person, COMPANY_A])).rejects.toThrow(/person_contact_wilaya_ck/);
    await query(db.superuserUrl, `insert into person_child (company_id, person_id, first_name, birth_date) select $2, $1, 'E' || g, date '2010-01-01' from generate_series(1, 15) g`, [person, COMPANY_A]);
    await expect(query(db.superuserUrl, `insert into person_child (company_id, person_id, first_name, birth_date) values ($2, $1, 'Seize', date '2010-01-01')`, [person, COMPANY_A])).rejects.toThrow(/at most 15 children/);
    for (const table of ['person_contact', 'person_family', 'profile_change_request', 'profile_change_file', 'profile_policy']) {
      await expect(inTenant(`delete from ${table}`), table).rejects.toThrow(/permission denied/);
    }
    // the emergency contact and children may be deleted (clearing / an approved change)
    await inTenant(`delete from person_child where person_id = $1`, [person]);
    await inTenant(`delete from person_emergency_contact where person_id = $1`, [person]);
  });
});

describe('audit', () => {
  it('the masked columns of migration 0025 (inventory)', async () => {
    const rows = await query<{ t: string }>(
      db.superuserUrl,
      `select table_name || '.' || column_name as t from audit.masked_column
        where table_name in ('person_contact', 'person_emergency_contact', 'person_family', 'person_child', 'profile_change_request', 'profile_change_file', 'profile_policy')
        order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual([
      'person_child.birth_date', 'person_child.first_name',
      'person_contact.address_line', 'person_contact.commune', 'person_contact.mobile_phone', 'person_contact.other_phone',
      'person_contact.personal_email', 'person_contact.postal_code', 'person_contact.wilaya_code',
      'person_emergency_contact.full_name', 'person_emergency_contact.phone',
      'person_family.marital_status_since',
      'profile_change_file.content', 'profile_change_file.original_filename',
      'profile_change_request.before', 'profile_change_request.employee_comment', 'profile_change_request.payload',
    ]);
  });

  it('row changes are recorded with the actor; phone, e-mail, address, contact and child names are masked', async () => {
    const contact = await changeLog('person_contact', demoEmployee(28).personId);
    expect(contact[0]).toMatchObject({ op: 'insert', after: { mobile_phone: '***', personal_email: '***', address_line: '***', commune: '***', wilaya_code: '***', postal_code: '***' } });
    expect(contact[0]?.actor_user_id).toBeTruthy();
    const dump = JSON.stringify(
      await query(db.superuserUrl, `select before, after from audit.change_log where table_name in ('person_contact', 'person_emergency_contact', 'person_family', 'person_child')`),
    );
    for (const value of ['555987654', '612345678', 'exemple.test', 'Glycines', 'El Khroub', '25100', 'Samir', '661112233', 'Rania', 'Ilyes', 'Nour', '2017-04-12', '2016-07-01']) {
      expect(dump, value).not.toContain(value);
    }
    // enums stay readable (the History says what changed)
    expect(dump).toContain('married');
    expect(dump).toContain('sibling');
  });

  it("the employee's History lists the personal-details changes (values masked)", async () => {
    const res = await client('admin').get(`/api/audit/timeline?subject=employee:${EST}&limit=100`).expect(200);
    const tables = new Set((res.body.items as { table?: string }[]).map((i) => i.table));
    for (const table of ['person_contact', 'person_emergency_contact', 'person_family', 'person_child']) expect(tables, table).toContain(table);
    expect(JSON.stringify(res.body)).not.toContain('Rania');
  });
});

describe('seed (seed:dev helpers)', () => {
  it('seedDemoPersonal fills most demo employees (idempotent); seedProfileDefaults gives the chains and the policy', async () => {
    const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    try {
      for (let run = 0; run < 2; run++) {
        await migrator.transaction().execute(async (tx) => {
          await seedProfileDefaults(tx, COMPANY_A);
          expect(await seedDemoPersonal(tx, COMPANY_A, demoEmployees())).toBe(35);
        });
      }
    } finally {
      await migrator.destroy();
    }
    const [counts] = await query<{ contacts: number; children: number; chains: string[]; policy: number }>(
      db.superuserUrl,
      `select (select count(*)::int from person_contact where company_id = $1) as contacts,
              (select count(*)::int from person_child where company_id = $1) as children,
              (select array_agg(code order by code) from workflow_definition where company_id = $1 and code like 'profile.%') as chains,
              (select count(*)::int from profile_policy where company_id = $1) as policy`,
      [COMPANY_A],
    );
    expect(counts?.contacts).toBeGreaterThanOrEqual(35);
    expect(counts?.children).toBeGreaterThan(5);
    expect(counts?.chains).toEqual(['profile.bank', 'profile.hr']);
    expect(counts?.policy).toBe(1);
    const [category] = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from employee_file_category where company_id = $1 and code = 'supporting_document' and is_system`, [COMPANY_A]);
    expect(category?.n).toBe(1);
  });
});
