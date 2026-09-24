import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_KEY_PATTERN as E2E_PATTERN } from '../../../apps/api/test/support/assert-no-secrets.ts';
import { ALLOW_FILE, checkAssertHelper, checkNoSecrets, loadAllowlist, scanSource, SECRET_KEY_PATTERN } from './no-secrets.ts';

const found = (file: string, src: string) => scanSource(file, src).map((f) => `${f.line} ${f.kind} ${f.symbol}.${f.property}`);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-secrets-'));
  temps.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe('no-secrets-in-payload: static scan', () => {
  it('uses the same key pattern as the e2e helper', () => {
    expect(SECRET_KEY_PATTERN.source).toBe(E2E_PATTERN.source);
  });

  it('flags DTO / response types by name anywhere', () => {
    const src = [
      'export class UserResponse { id!: string; passwordHash!: string; }', // 1
      'export interface SessionView { refreshToken: string; nested: { apiSecret: string } }', // 2
      'export type MePayload = { id: string };', // 3
      'export class TokenService { private token = "x"; }', // 4: not a DTO
      'interface InternalRow { password_hash: string }', // 5: not a DTO
    ].join('\n');
    expect(found('src/platform/x.ts', src)).toEqual([
      '1 DTO property UserResponse.passwordHash',
      '2 type SessionView.refreshToken',
      '2 type SessionView.apiSecret',
    ]);
  });

  it('flags zod DTO shapes (createZodDto) and constructor parameter properties', () => {
    const src = [
      "import { z } from 'zod';",
      'export class CreateUser extends createZodDto(z.object({ name: z.string(), password: z.string() })) {}',
      'export class ApiKeyDto { constructor(public readonly secretKey: string) {} }',
    ].join('\n');
    expect(found('src/x.ts', src)).toEqual(['2 zod DTO CreateUser.password', '3 DTO property ApiKeyDto.secretKey']);
  });

  it('flags every type in api/ files, *.dto.ts and *.controller.ts', () => {
    expect(found('src/modules/a/api/types.ts', 'export interface Anything { resetToken: string }')).toEqual(['1 type Anything.resetToken']);
    expect(found('src/modules/a/infra/types.ts', 'export interface Anything { resetToken: string }')).toEqual([]);
  });

  it('flags controller handler return literals and declared return types (incl. forward-declared interfaces)', () => {
    const src = [
      "import { Controller, Get as G, Post } from '@nestjs/common';",
      "@Controller('me')",
      'export class MeController {',
      '  @G() me(): Me { return { id: "1", profile: { sessionToken: "t" }, items: [1].map((i) => ({ hash: i })) }; }',
      '  @Post() login(): { ok: boolean; accessToken: string } { return { ok: true, accessToken: "x" }; }',
      '  helper() { return { password: "not a handler" }; }',
      '}',
      'interface Me { id: string; profile: { sessionToken: string } }',
    ].join('\n');
    expect(found('src/platform/me/me.ts', src)).toEqual([
      '8 handler return type Me.sessionToken',
      '4 handler return value MeController.me.sessionToken',
      '5 handler return type MeController.login.accessToken',
      '5 handler return value MeController.login.accessToken',
    ]);
  });
});

describe('no-secrets-in-payload: repo check with allowlist', () => {
  it('reports unlisted secrets and stale allowlist entries; honours valid entries', () => {
    const result = checkNoSecrets(path.join(import.meta.dirname, '__fixtures__/repo'));
    expect(result.violations.map((v) => `${v.rule} ${v.file}${v.line ? `:${v.line}` : ''} ${v.message}`)).toEqual([
      expect.stringMatching(/^secrets\/payload-key apps\/api\/src\/modules\/identity\/api\/auth\.controller\.ts:10 handler return value AuthController\.login declares "accessToken"/),
      expect.stringMatching(/^secrets\/allowlist tools\/guardrails\/secret-fields-allow\.json stale entry: .*ResetPasswordRequestDto\.token/),
    ]);
  });

  it('only accepts request/input DTOs with a reason in the allowlist', () => {
    const root = tempRoot({
      [ALLOW_FILE]: JSON.stringify([
        { file: 'a.ts', symbol: 'UserResponse', property: 'passwordHash', reason: 'nope' },
        { file: 'a.ts', symbol: 'LoginRequestDto', property: 'password', reason: '' },
        { file: 'a.ts', symbol: 'SignupInput', property: 'password', reason: 'signup input' },
      ]),
    });
    const { entries, violations } = loadAllowlist(root);
    expect(entries.map((e) => e.symbol)).toEqual(['SignupInput']);
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/entry 0 \(UserResponse\): only request\/input DTOs/),
      expect.stringMatching(/entry 1 needs non-empty/),
    ]);
  });

  it('requires the e2e helper assertNoSecrets with the same pattern', () => {
    expect(checkAssertHelper(tempRoot({}))).toEqual([expect.objectContaining({ message: expect.stringMatching(/missing/) })]);
    const weak = tempRoot({ 'apps/api/test/support/assert-no-secrets.ts': 'export const SECRET_KEY_PATTERN = /(password)/i;\nexport const assertNoSecrets = () => {};\n' });
    expect(checkAssertHelper(weak).map((v) => v.message)).toEqual([
      expect.stringMatching(/must export function assertNoSecrets/),
      expect.stringMatching(/must export SECRET_KEY_PATTERN/),
    ]);
  });
});
