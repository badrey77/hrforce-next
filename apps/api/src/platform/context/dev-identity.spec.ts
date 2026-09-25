import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { DevHeaderIdentityResolver } from './dev-identity.js';

const USER = '0190a5d0-0000-7000-8000-0000000000AA';
const COMPANY = '0190a5d0-0000-7000-8000-000000000001';
const req = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as Request;

describe('DevHeaderIdentityResolver', () => {
  const resolver = new DevHeaderIdentityResolver();

  it('reads X-Dev-User-Id / X-Dev-Company-Id (normalised to lowercase)', async () => {
    await expect(resolver.resolve(req({ 'x-dev-user-id': USER, 'x-dev-company-id': COMPANY }))).resolves.toEqual({
      userId: USER.toLowerCase(),
      companyId: COMPANY,
    });
  });

  it.each([
    ['no headers', {}],
    ['user only', { 'x-dev-user-id': USER }],
    ['company only', { 'x-dev-company-id': COMPANY }],
    ['non-UUID user', { 'x-dev-user-id': "x' or 1=1", 'x-dev-company-id': COMPANY }],
    ['non-UUID company', { 'x-dev-user-id': USER, 'x-dev-company-id': 'acme' }],
    ['repeated header', { 'x-dev-user-id': [USER, USER], 'x-dev-company-id': COMPANY }],
  ])('is anonymous with %s', async (_name, headers) => {
    await expect(resolver.resolve(req(headers))).resolves.toEqual({ userId: null, companyId: null });
  });
});
