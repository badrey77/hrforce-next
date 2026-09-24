import { Controller, Get, Module, Post, Body, Query, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { z } from 'zod';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';
import { Public, RequirePermission } from '../../src/platform/authz/decorators.js';
import { PermissionEvaluator } from '../../src/platform/authz/permission-evaluator.js';
import { ENV } from '../../src/platform/config/config.module.js';
import { loadEnv } from '../../src/platform/config/load-env.js';
import { currentContext, currentTx } from '../../src/platform/context/request-context.js';
import { RequestIdentityResolver, type RequestIdentity } from '../../src/platform/context/request-identity.js';
import { createZodDto } from '../../src/platform/http/zod-validation.pipe.js';
import type { TestDatabase } from './test-database.js';

/** Test-only identity: taken from X-Test-User / X-Test-Company headers (stands in for the Identity module). */
export class HeaderIdentityResolver extends RequestIdentityResolver {
  resolve(req: Request): Promise<RequestIdentity> {
    const user = req.headers['x-test-user'];
    const company = req.headers['x-test-company'];
    return Promise.resolve({
      userId: typeof user === 'string' ? user : null,
      companyId: typeof company === 'string' ? company : null,
    });
  }
}

/** Test-only evaluator: grants exactly the permissions in `TestPermissionEvaluator.granted`. */
export class TestPermissionEvaluator extends PermissionEvaluator {
  static granted: string[] = [];
  hasPermission(_identity: RequestIdentity, permission: string): Promise<boolean> {
    return Promise.resolve(TestPermissionEvaluator.granted.includes(permission));
  }
}

export class EchoDto extends createZodDto(
  z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
    address: z.object({ city: z.string().min(1) }),
  }),
) {}

export class ListQueryDto extends createZodDto(z.object({ limit: z.coerce.number().int().min(1).max(100) })) {}

@Controller('_test')
export class TestRoutesController {
  @Post('echo')
  @Public()
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  @Get('list')
  @Public()
  list(@Query() query: ListQueryDto): ListQueryDto {
    return query;
  }

  // Deliberately missing @Public()/@RequirePermission(): must be denied.
  @Get('undecorated')
  undecorated(): { ok: true } {
    return { ok: true };
  }

  @Get('boom')
  @Public()
  boom(): never {
    throw new Error('relation "secret_table" does not exist at /srv/internal/path.js');
  }

  @Get('context')
  @Public()
  context(): { requestId: string | undefined; hasTx: boolean } {
    const ctx = currentContext();
    return { requestId: ctx?.requestId, hasTx: ctx?.tx != null };
  }

  @Get('org-units')
  @RequirePermission('org_unit.read')
  async orgUnits(): Promise<{ codes: string[]; settings: { companyId: string; userId: string } }> {
    const tx = currentTx();
    const rows = await tx.selectFrom('org_unit').select('code').orderBy('code').execute();
    const settings = await tx
      .selectNoFrom((eb) => [
        eb.fn<string>('current_setting', [eb.val('app.company_id')]).as('companyId'),
        eb.fn<string>('current_setting', [eb.val('app.user_id')]).as('userId'),
      ])
      .executeTakeFirstOrThrow();
    return { codes: rows.map((r) => r.code), settings };
  }

  /** Inserts then fails: the request transaction must roll the insert back. */
  @Post('org-units/fail-after-insert')
  @RequirePermission('org_unit.create')
  async failAfterInsert(@Body() body: { companyId: string; code: string }): Promise<never> {
    await currentTx()
      .insertInto('org_unit')
      .values({ company_id: body.companyId, code: body.code, name: body.code })
      .execute();
    throw new Error('boom after insert');
  }
}

@Module({ controllers: [TestRoutesController] })
export class TestRoutesModule {}

export interface CreateTestAppOptions {
  extraModules?: Type[];
}

/** Builds the real AppModule (+ test routes) through the same configureApp() as main.ts. */
export async function createTestApp(db: TestDatabase, options: CreateTestAppOptions = {}): Promise<NestExpressApplication> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'silent',
    DATABASE_URL: db.appUrl,
    MIGRATOR_DATABASE_URL: db.migratorUrl,
    COOKIE_SECRET: 'test-cookie-secret-test-cookie-secret',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, TestRoutesModule, ...(options.extraModules ?? [])],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RequestIdentityResolver)
    .useClass(HeaderIdentityResolver)
    .overrideProvider(PermissionEvaluator)
    .useClass(TestPermissionEvaluator)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}
