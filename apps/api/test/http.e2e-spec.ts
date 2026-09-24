import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

const PROBLEM_JSON = /^application\/problem\+json/;

describe('HTTP platform (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('GET /api/health → 200 and checks the database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    assertNoSecrets(res.body);
  });

  it('propagates a valid incoming X-Request-Id', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('X-Request-Id', 'abc-123').expect(200);
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('exposes requestId and a transaction through RequestContext', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/context').set('X-Request-Id', 'ctx-1').expect(200);
    expect(res.body).toEqual({ requestId: 'ctx-1', hasTx: true });
  });

  it('unknown route → 404 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist').set('X-Request-Id', 'nf-1').expect(404);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.headers['x-request-id']).toBe('nf-1');
    expect(res.body).toMatchObject({
      type: 'urn:hrforce:problem:not-found',
      title: 'Not Found',
      status: 404,
      instance: '/api/does-not-exist',
      requestId: 'nf-1',
    });
  });

  it('routes live under the /api prefix only', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('invalid body → 422 with errors[] {field, code, message}', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_test/echo')
      .send({ name: '', age: 1.5, address: {} })
      .expect(422);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:validation-error', status: 422 });
    const errors = res.body.errors as { field: string; code: string; message: string }[];
    expect(errors.map((e) => e.field).toSorted()).toEqual(['address.city', 'age', 'name']);
    for (const e of errors) {
      expect(typeof e.code).toBe('string');
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it('valid body passes and is stripped of unknown keys', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_test/echo')
      .send({ name: 'Amina', age: 31, address: { city: 'Rabat' }, isAdmin: true })
      .expect(201);
    expect(res.body).toEqual({ name: 'Amina', age: 31, address: { city: 'Rabat' } });
  });

  it('invalid query → 422', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/list?limit=0').expect(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'limit', code: 'too_small' });
    await request(app.getHttpServer()).get('/api/_test/list?limit=5').expect(200, { limit: 5 });
  });

  it('malformed JSON → 400 problem+json', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_test/echo')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body.status).toBe(400);
  });

  it('a route with neither @RequirePermission nor @Public is denied', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/_test/undecorated')
      .set('X-Test-User', '018f0000-0000-7000-8000-000000000001')
      .expect(403);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden', status: 403 });
  });

  it('a protected route is 401 for anonymous callers', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/org-units').expect(401);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:unauthenticated', status: 401 });
  });

  it('unexpected errors → 500 without internals', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/boom').expect(500);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(Object.keys(res.body).toSorted()).toEqual(['instance', 'requestId', 'status', 'title', 'type']);
    expect(res.text).not.toMatch(/secret_table|\/srv\/internal|stack/);
  });

  it('does not advertise the framework', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('assertNoSecrets', () => {
  it('flags secret-looking keys at any depth', () => {
    expect(() => assertNoSecrets({ user: { name: 'a' }, items: [{ ok: 1 }] })).not.toThrow();
    expect(() => assertNoSecrets({ user: { passwordHash: 'x' } })).toThrowError(/\$\.user\.passwordHash/);
    expect(() => assertNoSecrets([{ refresh_TOKEN: 'x' }])).toThrowError(/refresh_TOKEN/);
    expect(() => assertNoSecrets({ a: [{ b: { clientSecret: 1 } }] })).toThrowError(/clientSecret/);
  });
});
